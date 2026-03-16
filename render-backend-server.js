const express = require('express');
const cors = require('cors');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { google } = require('googleapis');
const fs = require('fs');

const app = express();

// ─── CORS HEADERS - CRITICAL FOR WORDFENCE ──────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-WP-Nonce');
  res.header('Access-Control-Max-Age', '86400');
  
  // Wordfence bypass headers
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'SAMEORIGIN');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── CONFIG ──────────────────────────────────────────────
const PROJECT_ID = process.env.GOOGLE_PROJECT_ID;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

let ttsClient = null;
let driveClient = null;

// ─── INITIALIZE CLIENTS ──────────────────────────────────
async function initializeClients() {
  try {
    const credentials = JSON.parse(SERVICE_ACCOUNT_KEY);
    
    ttsClient = new TextToSpeechClient({ credentials });
    
    driveClient = google.drive({
      version: 'v3',
      auth: new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive']
      })
    });
    
    console.log('✓ Google Cloud TTS and Drive clients initialized');
  } catch (error) {
    console.error('✗ Failed to initialize clients:', error.message);
    process.exit(1);
  }
}

// ─── HEALTH CHECK ────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'LBC Blog TTS Render Backend',
    version: '3.5.0',
    timestamp: new Date().toISOString()
  });
});

// ─── GENERATE AUDIO ──────────────────────────────────────
app.post('/api/blog/generate-audio', async (req, res) => {
  try {
    const { blogText, blogPostId, blogUrl } = req.body;

    if (!blogText || blogText.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Blog text is required'
      });
    }

    // Split into chunks (2000 chars per chunk, respecting sentence boundaries)
    const chunks = splitIntoChunks(blogText, 2000);
    
    console.log(`Generating ${chunks.length} audio chunks for post ${blogPostId}`);

    // Generate all chunks in parallel
    const audioChunks = await Promise.all(
      chunks.map(async (text, index) => {
        try {
          const audioBase64 = await generateAudioWithSSML(text);
          console.log(`✓ Chunk ${index + 1}/${chunks.length} generated (${audioBase64.length} bytes)`);
          
          return {
            chunkIndex: index,
            text: text.substring(0, 100),
            audioBase64: audioBase64
          };
        } catch (error) {
          console.error(`✗ Chunk ${index + 1} failed:`, error.message);
          throw error;
        }
      })
    );

    res.json({
      success: true,
      postId: blogPostId,
      totalChunks: audioChunks.length,
      audioChunks: audioChunks
    });

  } catch (error) {
    console.error('Audio generation error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate audio'
    });
  }
});

// ─── GENERATE AUDIO WITH SSML ───────────────────────────
async function generateAudioWithSSML(text) {
  // Convert special characters for TTS
  let processedText = text
    .replace(/\bv\.s\b/gi, 'versus')
    .replace(/\b(\d+)%\b/g, '$1 percent')
    .replace(/\$(\d+)/g, '$1 dollars')
    .replace(/#(\d+)/g, 'number $1');

  // Add SSML breaks
  const ssmlText = `<speak>
    <prosody rate="1.0" pitch="0">
      ${processedText
        .split(/(?<=[.!?])\s+/)
        .map(sentence => `<s>${sentence.trim()}<break time="600ms"/></s>`)
        .join('\n')}
    </prosody>
  </speak>`;

  const request = {
    input: {
      ssml: ssmlText
    },
    voice: {
      languageCode: 'en-AU',
      name: 'en-AU-Standard-A'
    },
    audioConfig: {
      audioEncoding: 'MP3',
      sampleRateHertz: 24000,
      pitch: 0,
      speakingRate: 1.0
    }
  };

  try {
    const [response] = await ttsClient.synthesizeSpeech(request);
    const audioContent = response.audioContent;
    
    if (!audioContent) {
      throw new Error('No audio content returned from TTS API');
    }

    // Convert to base64
    const audioBase64 = Buffer.from(audioContent).toString('base64');
    
    return audioBase64;
  } catch (error) {
    console.error('TTS API error:', error.message);
    throw error;
  }
}

// ─── SPLIT INTO CHUNKS ──────────────────────────────────
function splitIntoChunks(text, maxChars) {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks = [];
  let currentChunk = '';

  const sentences = text.match(/[^.!?]*[.!?]+/g) || [text];

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxChars && currentChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter(chunk => chunk.length > 0);
}

// ─── START SERVER ───────────────────────────────────────
const PORT = process.env.PORT || 3000;

initializeClients().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✓ LBC Blog TTS API running on port ${PORT}`);
    console.log(`✓ Health check: http://localhost:${PORT}/health`);
    console.log(`✓ CORS headers enabled for all origins`);
  });
}).catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});