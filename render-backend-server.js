/**
 * LBC Blog TTS - Render Backend Service
 * Node.js Express server for multi-chunk audio generation + Google Drive caching
 * 
 * Deploy to: https://render.com
 * Environment variables needed:
 * - GOOGLE_PROJECT_ID
 * - GOOGLE_SERVICE_ACCOUNT_EMAIL
 * - GOOGLE_SERVICE_ACCOUNT_KEY (base64 encoded)
 * - GOOGLE_DRIVE_FOLDER_ID
 * - PORT (default: 3000)
 */

const express = require('express');
const cors = require('cors');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { google } = require('googleapis');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// ─── GOOGLE CLOUD SETUP ───────────────────────────────────

let ttsClient;
let driveClient;
let driveService;

async function initializeGoogle() {
  try {
    // Decode service account from environment
    const serviceAccountJSON = JSON.parse(
      Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString()
    );

    // Initialize TTS client
    ttsClient = new TextToSpeechClient({
      credentials: serviceAccountJSON,
      projectId: process.env.GOOGLE_PROJECT_ID
    });

    // Initialize Drive API
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountJSON,
      scopes: ['https://www.googleapis.com/auth/drive']
    });

    driveService = google.drive({ version: 'v3', auth });

    console.log('✅ Google Cloud services initialized');
  } catch (error) {
    console.error('❌ Google Cloud init error:', error.message);
    process.exit(1);
  }
}

// ─── SPLIT TEXT INTO CHUNKS ───────────────────────────────

function splitIntoChunks(text, maxSize = 2000) {
  const chunks = [];
  let current = '';

  // Split by sentences (respecting punctuation)
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

  console.log(`📄 Split into ${chunks.length} chunks (avg ${Math.round(text.length / chunks.length)} chars)`);
  return chunks;
}

// ─── TEXT TO SSML ─────────────────────────────────────────

function textToSSML(text) {
  let ssml = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Add natural pauses
  ssml = ssml.replace(/\n\n+/g, '<break time="800ms"/>');
  ssml = ssml.replace(/\n/g, '<break time="400ms"/>');
  ssml = ssml.replace(/([.!?])\s+/g, '$1<break time="350ms"/> ');
  ssml = ssml.replace(/:\s+/g, ':<break time="300ms"/> ');
  ssml = ssml.replace(/;\s+/g, ';<break time="250ms"/> ');
  ssml = ssml.replace(/,\s+/g, ',<break time="150ms"/> ');

  return `<speak>${ssml}</speak>`;
}

// ─── SYNTHESIZE ONE CHUNK ─────────────────────────────────

async function synthesizeChunk(text, chunkIndex) {
  try {
    const ssml = textToSSML(text);
    const ssmlSize = Buffer.byteLength(ssml, 'utf8');

    if (ssmlSize > 4800) {
      throw new Error(`SSML too large: ${ssmlSize} bytes (max 5000)`);
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
        pitch: 0,
        volumeGainDb: 0,
      },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    const audioContent = response.audioContent;

    console.log(`🔊 Chunk ${chunkIndex}: Generated ${audioContent.length} bytes`);
    return audioContent;
  } catch (error) {
    console.error(`❌ Chunk ${chunkIndex} error:`, error.message);
    throw error;
  }
}

// ─── CACHE TO GOOGLE DRIVE ────────────────────────────────

async function uploadToDrive(audioBuffer, filename, mimeType = 'audio/mpeg') {
  try {
    const fileMetadata = {
      name: filename,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    };

    const media = {
      mimeType: mimeType,
      body: audioBuffer,
    };

    const file = await driveService.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webContentLink',
    });

    console.log(`☁️  Cached to Drive: ${filename} (ID: ${file.data.id})`);
    return file.data.id;
  } catch (error) {
    console.error('❌ Drive upload error:', error.message);
    throw error;
  }
}

// ─── CHECK IF CACHED ──────────────────────────────────────

async function getCachedFile(filename) {
  try {
    const response = await driveService.files.list({
      q: `name='${filename}' and parents='${process.env.GOOGLE_DRIVE_FOLDER_ID}' and trashed=false`,
      spaces: 'drive',
      fields: 'files(id, name)',
      pageSize: 1,
    });

    if (response.data.files.length > 0) {
      console.log(`✅ Found cached: ${filename}`);
      return response.data.files[0].id;
    }

    return null;
  } catch (error) {
    console.error('❌ Drive query error:', error.message);
    return null;
  }
}

// ─── DOWNLOAD FROM DRIVE ──────────────────────────────────

async function downloadFromDrive(fileId) {
  try {
    const response = await driveService.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );

    console.log(`📥 Downloaded from Drive: ${fileId}`);
    return Buffer.from(response.data);
  } catch (error) {
    console.error('❌ Drive download error:', error.message);
    throw error;
  }
}

// ─── GENERATE HASH FOR CACHING ────────────────────────────

function generateHash(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

// ─── API ENDPOINTS ────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'LBC Blog TTS Render Backend',
    version: '1.0.0',
  });
});

// Main endpoint: Generate multi-chunk audio
app.post('/api/blog/generate-audio', async (req, res) => {
  const startTime = Date.now();

  try {
    const { blogContent, blogUrl, blogPostId } = req.body;

    if (!blogContent && !blogUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing blogContent or blogUrl',
      });
    }

    let content = blogContent;
    if (!content && blogUrl) {
      // Fetch from URL if needed
      try {
        const response = await fetch(blogUrl);
        const html = await response.text();

        // Extract entry-content
        const match = html.match(
          /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i
        );
        if (match) {
          content = match[1]
            .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n$1\n\n')
            .replace(/<p[^>]*>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, ' and ')
            .replace(/&nbsp;/g, ' ')
            .trim();
        }
      } catch (fetchError) {
        console.error('Fetch error:', fetchError.message);
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

    // Split into chunks
    const chunks = splitIntoChunks(content, 2000);

    // Generate hash for caching
    const contentHash = generateHash(content);
    const cacheKey = `lbc-blog-${blogPostId || contentHash}`;

    // Check if fully cached
    const cachedFileId = await getCachedFile(`${cacheKey}-metadata.json`);
    if (cachedFileId) {
      console.log(`✅ Blog fully cached, returning cached audio`);
      
      const metadata = JSON.parse(
        await downloadFromDrive(cachedFileId).then(b => b.toString())
      );

      const audioChunks = [];
      for (let i = 0; i < metadata.chunkCount; i++) {
        const chunkFileId = await getCachedFile(`${cacheKey}-chunk-${i}.mp3`);
        if (chunkFileId) {
          const audioBuffer = await downloadFromDrive(chunkFileId);
          audioChunks.push({
            index: i,
            audioBase64: audioBuffer.toString('base64'),
            textLength: metadata.chunks[i].length,
          });
        }
      }

      return res.json({
        success: true,
        cached: true,
        audioChunks: audioChunks,
        totalChunks: audioChunks.length,
        totalChars: content.length,
        generationTime: Date.now() - startTime,
      });
    }

    // Generate new audio
    console.log(`🎙️  Generating audio for ${chunks.length} chunks...`);
    const audioChunks = [];
    const chunkMetadata = [];

    for (let i = 0; i < chunks.length; i++) {
      try {
        const audioBuffer = await synthesizeChunk(chunks[i], i);

        // Cache to Drive
        const filename = `${cacheKey}-chunk-${i}.mp3`;
        await uploadToDrive(audioBuffer, filename, 'audio/mpeg');

        audioChunks.push({
          index: i,
          audioBase64: audioBuffer.toString('base64'),
          textLength: chunks[i].length,
        });

        chunkMetadata.push({
          index: i,
          length: chunks[i].length,
        });

        console.log(`✅ Chunk ${i + 1}/${chunks.length} done`);
      } catch (chunkError) {
        console.error(`Error on chunk ${i}:`, chunkError.message);
        throw chunkError;
      }
    }

    // Cache metadata
    const metadata = {
      cacheKey: cacheKey,
      chunkCount: chunks.length,
      totalChars: content.length,
      chunks: chunkMetadata,
      generatedAt: new Date().toISOString(),
    };

    await uploadToDrive(
      Buffer.from(JSON.stringify(metadata)),
      `${cacheKey}-metadata.json`,
      'application/json'
    );

    console.log(`\n✅ All ${chunks.length} chunks generated and cached`);

    res.json({
      success: true,
      cached: false,
      audioChunks: audioChunks,
      totalChunks: audioChunks.length,
      totalChars: content.length,
      generationTime: Date.now() - startTime,
    });
  } catch (error) {
    console.error('❌ Generation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Health check for dependencies
app.get('/api/health/detailed', async (req, res) => {
  try {
    // Check TTS
    const ttsOk = ttsClient ? true : false;

    // Check Drive
    const driveOk = driveService ? true : false;

    res.json({
      status: ttsOk && driveOk ? 'healthy' : 'degraded',
      tts: ttsOk ? 'ok' : 'error',
      drive: driveOk ? 'ok' : 'error',
      projectId: process.env.GOOGLE_PROJECT_ID ? 'set' : 'missing',
      driveFolder: process.env.GOOGLE_DRIVE_FOLDER_ID ? 'set' : 'missing',
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
    });
  }
});

// ─── START SERVER ─────────────────────────────────────────

const PORT = process.env.PORT || 3000;

async function start() {
  await initializeGoogle();

  app.listen(PORT, () => {
    console.log(`\n🚀 LBC Blog TTS Render Backend running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📍 Generate audio: POST http://localhost:${PORT}/api/blog/generate-audio\n`);
  });
}

start().catch((error) => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});
