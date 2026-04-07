/**
 * LBC Blog TTS - Render Backend v3.3
 * RESTORED: Google Drive Caching RE-ENABLED
 * First check cache, then generate fresh audio, then save to cache
 */

const express = require('express');
const cors = require('cors');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { google } = require('googleapis');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

let ttsClient;
let driveClient;

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

    // Initialize Google Drive for caching
    driveClient = google.drive({
      version: 'v3',
      auth: new google.auth.GoogleAuth({
        credentials: serviceAccountJSON,
        scopes: ['https://www.googleapis.com/auth/drive'],
      }),
    });

    console.log('✅ Google Cloud TTS initialized');
    console.log('✅ Google Drive caching initialized');

  } catch (error) {
    console.error('❌ Google Cloud init error:', error.message);
    process.exit(1);
  }
}

function generateContentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

async function checkDriveCache(contentHash, blogPostId) {
  try {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) {
      console.log('⚠️  No GOOGLE_DRIVE_FOLDER_ID set, skipping cache check');
      return null;
    }

    const fileName = `audio_${blogPostId}_${contentHash}.mp3`;
    
    const response = await driveClient.files.list({
      q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
      spaces: 'drive',
      fields: 'files(id, name, size)',
      pageSize: 1,
    });

    if (response.data.files && response.data.files.length > 0) {
      const file = response.data.files[0];
      console.log(`💾 Found cached audio: ${file.name} (${file.size} bytes)`);
      
      const mediaResponse = await driveClient.files.get(
        { fileId: file.id, alt: 'media' },
        { responseType: 'arraybuffer' }
      );
      
      return Buffer.from(mediaResponse.data);
    }

    return null;
  } catch (error) {
    console.error(`⚠️  Cache check failed: ${error.message}`);
    return null;
  }
}

async function saveDriveCache(audioBuffer, contentHash, blogPostId) {
  try {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) {
      console.log('⚠️  No GOOGLE_DRIVE_FOLDER_ID set, skipping cache save');
      return;
    }

    const fileName = `audio_${blogPostId}_${contentHash}.mp3`;

    const response = await driveClient.files.create({
      resource: {
        name: fileName,
        parents: [folderId],
        mimeType: 'audio/mpeg',
      },
      media: {
        mimeType: 'audio/mpeg',
        body: audioBuffer,
      },
      fields: 'id, name, size',
    });

    console.log(`✅ Audio cached to Drive: ${response.data.name} (${audioBuffer.length} bytes)`);
    return response.data.id;
  } catch (error) {
    console.error(`⚠️  Cache save failed: ${error.message}`);
    return null;
  }
}

function splitIntoChunks(text, maxSize = 2000) {
  const chunks = [];
  let current = '';

  const sections = text.split(/\n(?=[A-Z][A-Za-z\s]{3,80}(?:\n|$))/);

  for (const section of sections) {
    if (!section.trim()) continue;

    const sentences = section.match(/[^.!?]*[.!?]+/g) || [section];

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
      current = '';
    }

    chunks.push('[PAUSE_2000ms]');
  }

  if (chunks.length > 0 && chunks[chunks.length - 1] === '[PAUSE_2000ms]') {
    chunks.pop();
  }

  console.log(`📄 Split into ${chunks.length} chunks (including pauses)`);
  return chunks;
}

function textToSSML(text) {
  let ssml = text
    .replace(/(\d+)\s*–\s*(\d+)/g, '$1 to $2')
    .replace(/(\d+)\s*—\s*(\d+)/g, '$1 to $2')
    .replace(/(\d+)\s*-\s*(\d+)/g, '$1 to $2')
    .replace(/(\d+)\s*(?:–|—|-)\s*(\d+)\s*°\s*C/gi, '$1 to $2 degrees Celsius')
    .replace(/(\d+)\s*(?:–|—|-)\s*(\d+)\s*°\s*F/gi, '$1 to $2 degrees Fahrenheit')
    .replace(/(\d+)\s*(?:–|—|-)\s*(\d+)%/g, '$1 to $2 percent')
    .replace(/°/g, ' degrees ')
    .replace(/%/g, ' percent ')
    .replace(/\$/g, ' dollar ')
    .replace(/#/g, ' number ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  ssml = ssml.replace(/^([A-Z][A-Za-z0-9\s]{5,80})(\n)/gm, '$1<break strength="x-strong" time="1500ms"/>\n');
  ssml = ssml.replace(/^([A-Z][A-Za-z0-9\s]{5,80})(\n)(?=[A-Z])/gm, '$1<break strength="strong" time="1200ms"/>\n');

  ssml = ssml.replace(/\bSA's\b/gi, "South Australia's");
  ssml = ssml.replace(/\bSAs\b/gi, "South Australia's");
  
  ssml = ssml.replace(/\bFAQ\b/gi, 'F.A.Q.');
  ssml = ssml.replace(/\bFAQs\b/gi, 'F.A.Q.s');
  ssml = ssml.replace(/\bLED\b/gi, 'L.E.D.');
  ssml = ssml.replace(/\bHIFU\b/gi, 'H.I.F.U.');
  ssml = ssml.replace(/\bIPL\b/gi, 'I.P.L.');
  ssml = ssml.replace(/\bSHR\b/gi, 'S.H.R.');
  ssml = ssml.replace(/\bTGA\b/gi, 'T.G.A.');
  ssml = ssml.replace(/\bUV\b/gi, 'U.V.');
  ssml = ssml.replace(/\bAHA\b/gi, 'A.H.A.');
  ssml = ssml.replace(/\bBHA\b/gi, 'B.H.A.');
  ssml = ssml.replace(/\bAHAs\b/gi, 'A.H.A.s');
  ssml = ssml.replace(/\bBHAs\b/gi, 'B.H.A.s');
  ssml = ssml.replace(/\bSPF\b/gi, 'S.P.F.');
  ssml = ssml.replace(/\bNIR\b/gi, 'N.I.R.');
  ssml = ssml.replace(/\bPCOS\b/gi, 'P.C.O.S.');
  
  ssml = ssml.replace(/([-•*][^\n]+?)(?=\n)/gm, '$1<break strength="medium" time="800ms"/>');
  ssml = ssml.replace(/\n\n+/g, '<break strength="strong" time="1000ms"/>');
  ssml = ssml.replace(/([.!?])(\s+)(?=[A-Z])/g, '$1<break time="600ms"/>$2');
  ssml = ssml.replace(/,(\s+)/g, ',<break time="250ms"/>$1');

  return `<speak>${ssml}</speak>`;
}

async function synthesizeChunk(text, chunkIndex) {
  try {
    if (text === '[PAUSE_2000ms]') {
      return Buffer.from('');
    }

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
    console.log(`🔊 Chunk ${chunkIndex}: ${response.audioContent.length} bytes`);
    return response.audioContent;
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
    version: '3.3',
    caching: 'enabled',
  });
});

// GENERATE AUDIO with CACHING
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

    const contentHash = generateContentHash(content);
    
    // STEP 1: Check cache first
    console.log('🔍 Checking Google Drive cache...');
    const cachedAudio = await checkDriveCache(contentHash, blogPostId);
    
    if (cachedAudio) {
      console.log(`✅ Using cached audio (${cachedAudio.length} bytes)`);
      const chunks = splitIntoChunks(content, 2000);
      const audioChunks = [{
        index: 0,
        audioBase64: cachedAudio.toString('base64'),
        isCached: true,
      }];
      
      return res.json({
        success: true,
        audioChunks: audioChunks,
        totalChunks: 1,
        totalChars: content.length,
        generationTime: Date.now() - startTime,
        fromCache: true,
      });
    }

    // STEP 2: Generate fresh audio
    const chunks = splitIntoChunks(content, 2000);
    console.log(`🎙️  Generating ${chunks.length} audio chunks...\n`);

    const audioChunks = [];
    const synthPromises = chunks.map((chunk, index) =>
      synthesizeChunk(chunk, index)
        .then(audioBuffer => {
          audioChunks[index] = {
            index: index,
            audioBase64: audioBuffer.length > 0 ? audioBuffer.toString('base64') : '',
            textLength: chunk.length,
          };
          console.log(`✅ Chunk ${index + 1}/${chunks.length} ready`);
        })
        .catch(error => {
          console.error(`❌ Chunk ${index} failed:`, error.message);
          throw error;
        })
    );

    await Promise.all(synthPromises);
    audioChunks.sort((a, b) => a.index - b.index);
    const validChunks = audioChunks.filter(c => c.audioBase64 || c.audioBase64 === '');

    const estimatedDurations = chunks.map(chunkText => {
      const estimatedSeconds = Math.ceil(chunkText.length / 150);
      return estimatedSeconds;
    });

    console.log(`\n✅ All ${validChunks.length} chunks generated in ${Date.now() - startTime}ms`);

    // STEP 3: Cache the combined audio
    console.log('💾 Saving to Google Drive cache...');
    const combinedAudio = Buffer.concat(
      validChunks.map(chunk => 
        chunk.audioBase64 ? Buffer.from(chunk.audioBase64, 'base64') : Buffer.from('')
      )
    );
    
    try {
      await saveDriveCache(combinedAudio, contentHash, blogPostId);
    } catch (cacheError) {
      console.error(`⚠️  Cache save failed: ${cacheError.message}`);
    }

    res.json({
      success: true,
      audioChunks: validChunks,
      totalChunks: validChunks.length,
      totalChars: content.length,
      generationTime: Date.now() - startTime,
      fromCache: false,
      estimatedDurations: estimatedDurations,
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
    console.log(`\n🚀 LBC Blog TTS Render Backend v3.3 running on port ${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/health`);
    console.log(`📍 Generate: POST http://localhost:${PORT}/api/blog/generate-audio`);
    console.log(`📍 Google Drive Caching: ENABLED\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});
