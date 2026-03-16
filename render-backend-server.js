/**
 * LBC Blog TTS - Render Backend (Fixed Audio)
 * Simpler SSML, proper buffer handling
 */

const express = require('express');
const cors = require('cors');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

let ttsClient;

async function initializeGoogle() {
  try {
    const serviceAccountKeyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    
    if (!serviceAccountKeyString) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
    }

    let serviceAccountJSON;
    try {
      serviceAccountJSON = JSON.parse(serviceAccountKeyString);
    } catch (e) {
      serviceAccountJSON = JSON.parse(
        Buffer.from(serviceAccountKeyString, 'base64').toString()
      );
    }

    ttsClient = new TextToSpeechClient({
      credentials: serviceAccountJSON,
      projectId: process.env.GOOGLE_PROJECT_ID
    });

    console.log('✅ Google Cloud services initialized');
  } catch (error) {
    console.error('❌ Google Cloud init error:', error.message);
    process.exit(1);
  }
}

function splitIntoChunks(text, maxSize = 2000) {
  const chunks = [];
  let current = '';

  const sentences = text.match(/[^.!?]*[.!?]+/g) || [text];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length > maxSize && current.length > 0) {
      chunks.push(current.trim());
      current = trimmed;
    } else {
      current += (current ? ' ' : '') + trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

function textToSSML(text) {
  // Simple SSML without effects that might corrupt data
  let ssml = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Add breaks for natural pausing
  ssml = ssml.replace(/\n\n+/g, ' <break time="1200ms"/> ');
  ssml = ssml.replace(/\n/g, ' <break time="600ms"/> ');
  ssml = ssml.replace(/([.!?])(\s+)(?=[A-Z])/g, '$1 <break time="800ms"/> $2');
  ssml = ssml.replace(/,(\s+)/g, ', <break time="200ms"/> $1');

  return `<speak>${ssml}</speak>`;
}

async function synthesizeChunk(text, chunkIndex) {
  try {
    const ssml = textToSSML(text);
    const ssmlSize = Buffer.byteLength(ssml, 'utf8');

    if (ssmlSize > 4800) {
      throw new Error(`SSML too large: ${ssmlSize} bytes`);
    }

    const request = {
      input: { ssml },
      voice: {
        languageCode: 'en-AU',
        name: 'en-AU-Neural2-C',
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 0.92,
      },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    
    // Get the audio content as Buffer
    const audioBuffer = response.audioContent;
    
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error('Empty audio buffer received');
    }

    console.log(`🔊 Chunk ${chunkIndex}: ${audioBuffer.length} bytes`);
    return audioBuffer;
  } catch (error) {
    console.error(`❌ Chunk ${chunkIndex} error:`, error.message);
    throw error;
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'LBC Blog TTS Render Backend',
    version: '3.1.0',
  });
});

// Generate audio endpoint
app.post('/api/blog/generate-audio', async (req, res) => {
  const startTime = Date.now();

  try {
    const { blogContent, blogText, blogUrl, blogPostId } = req.body;

    const textContent = blogContent || blogText;

    if (!textContent && !blogUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing blogContent/blogText or blogUrl',
      });
    }

    let content = textContent;
    if (!content && blogUrl) {
      try {
        const response = await fetch(blogUrl);
        const html = await response.text();

        const match = html.match(
          /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i
        );
        if (match) {
          content = match[1]
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, ' and ')
            .replace(/&nbsp;/g, ' ')
            .trim();
        }
      } catch (fetchError) {
        return res.status(400).json({
          success: false,
          error: 'Could not fetch blog content',
        });
      }
    }

    if (!content || content.length < 100) {
      return res.status(400).json({
        success: false,
        error: 'Content too short or empty',
      });
    }

    console.log(`\n📝 Processing blog: ${content.length} chars`);

    const chunks = splitIntoChunks(content, 2000);
    console.log(`🎙️  Generating ${chunks.length} audio chunks in parallel...\n`);

    // Generate all chunks in parallel
    const audioChunks = [];
    const synthPromises = chunks.map((chunk, index) =>
      synthesizeChunk(chunk, index)
        .then(audioBuffer => {
          // Convert buffer to base64 string
          const base64String = audioBuffer.toString('base64');
          
          audioChunks[index] = {
            index: index,
            audioBase64: base64String,
            textLength: chunk.length,
            bufferSize: audioBuffer.length,
          };
          console.log(`✅ Chunk ${index + 1}/${chunks.length} ready (${audioBuffer.length} bytes)`);
        })
        .catch(error => {
          console.error(`❌ Chunk ${index} failed:`, error.message);
          throw error;
        })
    );

    await Promise.all(synthPromises);

    // Sort to ensure correct order
    audioChunks.sort((a, b) => a.index - b.index);

    const totalSize = audioChunks.reduce((sum, chunk) => sum + chunk.bufferSize, 0);
    console.log(`\n✅ All ${audioChunks.length} chunks generated in ${Date.now() - startTime}ms`);
    console.log(`📊 Total audio size: ${totalSize} bytes\n`);

    res.json({
      success: true,
      audioChunks: audioChunks,
      totalChunks: audioChunks.length,
      totalChars: content.length,
      generationTime: Date.now() - startTime,
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  await initializeGoogle();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 LBC Blog TTS Render Backend v3.1.0 running on port ${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/health`);
    console.log(`📍 Generate: POST http://localhost:${PORT}/api/blog/generate-audio\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});