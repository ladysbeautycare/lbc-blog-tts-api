/**
 * LBC Blog TTS - Render Backend v4.0 CHIRP EDITION
 * Uses Chirp 3: HD voices for maximum natural, human-like narration.
 *
 * KEY DIFFERENCES FROM v3.3 (Neural2):
 *   - Chirp 3: HD voice (en-AU-Chirp3-HD-Aoede) — far more natural intonation
 *   - NO SSML — Chirp ignores SSML tags, so we use PLAIN TEXT
 *   - Pauses created via punctuation & spacing (Chirp phrases naturally)
 *   - Acronyms spelled phonetically in plain text (HIFU -> "high foo")
 *   - Number ranges & symbols expanded to words
 *   - Same Google Drive caching (separate cache keys via voice tag)
 *
 * A/B TESTING: Deploy this as a SEPARATE Render service (or swap the file
 * and clear the Drive cache) to compare against the Neural2 version.
 */

const express = require('express');
const cors = require('cors');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { google } = require('googleapis');
const crypto = require('crypto');
const { Readable } = require('stream');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// ─── VOICE CONFIG ─────────────────────────────────────────
// Chirp 3: HD Australian voices to try (all female, very natural):
//   en-AU-Chirp3-HD-Aoede   — warm, friendly (recommended for blogs)
//   en-AU-Chirp3-HD-Leda    — bright, energetic
//   en-AU-Chirp3-HD-Kore    — calm, measured
//   en-AU-Chirp3-HD-Zephyr  — soft, gentle
const VOICE_NAME = 'en-AU-Chirp3-HD-Aoede';
const SPEAKING_RATE = 1.0; // Chirp sounds natural at 1.0; lower if too fast

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

    driveClient = google.drive({
      version: 'v3',
      auth: new google.auth.GoogleAuth({
        credentials: serviceAccountJSON,
        scopes: ['https://www.googleapis.com/auth/drive'],
        clientOptions: process.env.GOOGLE_DRIVE_IMPERSONATE_USER
          ? { subject: process.env.GOOGLE_DRIVE_IMPERSONATE_USER }
          : {},
      }),
    });

    console.log('✅ Google Cloud TTS initialized (Chirp 3: HD)');
    console.log(`✅ Voice: ${VOICE_NAME}`);
    if (process.env.GOOGLE_DRIVE_IMPERSONATE_USER) {
      console.log(`✅ Google Drive caching initialized (impersonating ${process.env.GOOGLE_DRIVE_IMPERSONATE_USER})`);
    } else {
      console.log('⚠️  Drive caching WITHOUT impersonation — saves will fail (service account has no quota)');
    }

  } catch (error) {
    console.error('❌ Google Cloud init error:', error.message);
    process.exit(1);
  }
}

function generateContentHash(content) {
  // Include voice in hash so Chirp & Neural2 caches don't collide
  return crypto.createHash('sha256')
    .update(content + '::' + VOICE_NAME)
    .digest('hex').substring(0, 16);
}

async function checkDriveCache(contentHash, blogPostId) {
  try {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) {
      console.log('⚠️  No GOOGLE_DRIVE_FOLDER_ID set, skipping cache check');
      return null;
    }

    const fileName = `audio_chirp_${blogPostId}_${contentHash}.mp3`;

    const response = await driveClient.files.list({
      q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
      spaces: 'drive',
      fields: 'files(id, name, size)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (response.data.files && response.data.files.length > 0) {
      const file = response.data.files[0];
      console.log(`💾 Found cached audio: ${file.name} (${file.size} bytes)`);
      const mediaResponse = await driveClient.files.get(
        { fileId: file.id, alt: 'media', supportsAllDrives: true },
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

    const fileName = `audio_chirp_${blogPostId}_${contentHash}.mp3`;

    // googleapis needs a readable STREAM for the body, not a raw Buffer
    const bufferStream = new Readable();
    bufferStream.push(audioBuffer);
    bufferStream.push(null);

    const response = await driveClient.files.create({
      resource: {
        name: fileName,
        parents: [folderId],
        mimeType: 'audio/mpeg',
      },
      media: {
        mimeType: 'audio/mpeg',
        body: bufferStream,
      },
      fields: 'id, name, size',
      supportsAllDrives: true,
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

// ─── PLAIN TEXT CLEANING FOR CHIRP (NO SSML) ──────────────
// Chirp ignores SSML, so we shape pronunciation & pacing with
// plain text only. Pauses come from punctuation; Chirp phrases
// naturally on its own.
function cleanTextForChirp(text) {
  let t = text
    // FIRST: decode HTML entities for dashes & spaces so ranges match.
    // WordPress often passes these through un-decoded (e.g. 2&#8211;3).
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&#8211;/g, '\u2013')
    .replace(/&#8212;/g, '\u2014')
    .replace(/&#x2013;/gi, '\u2013')
    .replace(/&#x2014;/gi, '\u2014')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&minus;/gi, '\u2212')
    .replace(/&#8722;/g, '\u2212')
    // Strip any stray HTML tags between content (e.g. 2<span>-</span>3)
    .replace(/<[^>]+>/g, '')
    // Ranges WITH units first (most specific)
    .replace(/(\d+)\s*[\u002D\u2010\u2011\u2012\u2013\u2014\u2015\u2212]\s*(\d+)\s*(min(?:ute)?s?)\b/gi, '$1 to $2 minutes')
    .replace(/(\d+)\s*[\u002D\u2010\u2011\u2012\u2013\u2014\u2015\u2212]\s*(\d+)\s*(hr?s?|hours?)\b/gi, '$1 to $2 hours')
    .replace(/(\d+)\s*[\u002D\u2010\u2011\u2012\u2013\u2014\u2015\u2212]\s*(\d+)\s*(cm|mm|km|m)\b/gi, '$1 to $2 $3')
    .replace(/(\d+)\s*[\u002D\u2010\u2011\u2012\u2013\u2014\u2015\u2212]\s*(\d+)\s*°\s*C/gi, '$1 to $2 degrees Celsius')
    .replace(/(\d+)\s*[\u002D\u2010\u2011\u2012\u2013\u2014\u2015\u2212]\s*(\d+)\s*°\s*F/gi, '$1 to $2 degrees Fahrenheit')
    .replace(/(\d+)\s*[\u002D\u2010\u2011\u2012\u2013\u2014\u2015\u2212]\s*(\d+)\s*%/g, '$1 to $2 percent')
    // Generic number range (catches everything else)
    .replace(/(\d+)\s*[\u002D\u2010\u2011\u2012\u2013\u2014\u2015\u2212]\s*(\d+)/g, '$1 to $2')
    // Units & symbols -> words
    .replace(/(\d+)\s*°\s*C/gi, '$1 degrees Celsius')
    .replace(/(\d+)\s*°\s*F/gi, '$1 degrees Fahrenheit')
    .replace(/°/g, ' degrees ')
    .replace(/(\d+)\s*%/g, '$1 percent')
    .replace(/%/g, ' percent ')
    .replace(/\$\s*(\d+)/g, '$1 dollars')
    .replace(/\$/g, ' dollars ')
    .replace(/#/g, ' number ')
    // Booking URL -> spoken
    .replace(/https?:\/\/ladysbeautycare\.com\.au\/booking\/?/gi, 'ladys beauty care dot com dot au slash booking')
    // Strip any other URLs
    .replace(/https?:\/\/\S+/g, '')
    // Acronym pronunciation (plain phonetic — Chirp reads these naturally)
    .replace(/\bSA's\b/g, "South Australia's")
    .replace(/\bSAs\b/g, "South Australia's")
    .replace(/\bHIFU\b/gi, 'High-Foo')
    .replace(/\bIPL\b/gi, 'I P L')
    .replace(/\bSHR\b/gi, 'S H R')
    .replace(/\bLED\b/gi, 'L E D')
    .replace(/\bSPF\b/gi, 'S P F')
    .replace(/\bAHAs\b/gi, 'A H As')
    .replace(/\bBHAs\b/gi, 'B H As')
    .replace(/\bAHA\b/gi, 'A H A')
    .replace(/\bBHA\b/gi, 'B H A')
    .replace(/\bNIR\b/gi, 'N I R')
    .replace(/\bUV\b/gi, 'U V')
    .replace(/\bTGA\b/gi, 'T G A')
    .replace(/\bPCOS\b/gi, 'P C O S')
    .replace(/\bFAQs\b/gi, 'F A Qs')
    .replace(/\bFAQ\b/gi, 'F A Q')
    // Bullet markers -> sentence break (period gives Chirp a natural pause)
    .replace(/^\s*[-•*]\s*/gm, '')
    // Collapse whitespace
    .replace(/\n{2,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  console.log('CHIRP OUT:', JSON.stringify(t.substring(0, 250)));
  return t;
}

async function synthesizeChunk(text, chunkIndex) {
  if (text === '[PAUSE_2000ms]') {
    return Buffer.from('');
  }

  const plainText = cleanTextForChirp(text);

  // Chirp uses plain text input (NOT ssml)
  const request = {
    input: { text: plainText },
    voice: {
      languageCode: 'en-AU',
      name: VOICE_NAME,
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: SPEAKING_RATE,
    },
  };

  // Retry transient Google errors (13 INTERNAL, 14 UNAVAILABLE, 8 RESOURCE_EXHAUSTED)
  // which occur under burst load. Up to 4 attempts with increasing backoff.
  const MAX_ATTEMPTS = 4;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const [response] = await ttsClient.synthesizeSpeech(request);
      console.log(`🔊 Chunk ${chunkIndex}: ${response.audioContent.length} bytes` + (attempt > 1 ? ` (attempt ${attempt})` : ''));
      return response.audioContent;
    } catch (error) {
      lastError = error;
      const code = error.code;
      const retryable = code === 13 || code === 14 || code === 8 ||
                        /INTERNAL|UNAVAILABLE|RESOURCE_EXHAUSTED|deadline/i.test(error.message || '');
      if (retryable && attempt < MAX_ATTEMPTS) {
        const waitMs = 500 * attempt + Math.floor(Math.random() * 400);
        console.warn(`⚠️  Chunk ${chunkIndex} attempt ${attempt} failed (${error.message}). Retrying in ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      console.error(`❌ Chunk ${chunkIndex} error:`, error.message);
      throw error;
    }
  }
  throw lastError;
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'LBC Blog TTS Render Backend',
    version: '4.0-chirp',
    voice: VOICE_NAME,
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
      return res.status(400).json({ success: false, error: 'Missing blogContent/blogText or blogUrl' });
    }

    let content = textContent;
    if (!content && blogUrl) {
      try {
        const response = await fetch(blogUrl);
        const html = await response.text();
        const match = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (match) {
          content = match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, ' and ').replace(/&nbsp;/g, ' ').trim();
        }
      } catch (fetchError) {
        return res.status(400).json({ success: false, error: 'Could not fetch blog content' });
      }
    }

    if (!content || content.length < 100) {
      return res.status(400).json({ success: false, error: 'Content too short or empty' });
    }

    console.log(`\n📝 Processing blog: ${content.length} chars`);

    const contentHash = generateContentHash(content);

    console.log('🔍 Checking Google Drive cache...');
    const cachedAudio = await checkDriveCache(contentHash, blogPostId);

    if (cachedAudio) {
      console.log(`✅ Using cached audio (${cachedAudio.length} bytes)`);
      return res.json({
        success: true,
        audioChunks: [{ index: 0, audioBase64: cachedAudio.toString('base64'), isCached: true }],
        totalChunks: 1,
        totalChars: content.length,
        generationTime: Date.now() - startTime,
        fromCache: true,
      });
    }

    const chunks = splitIntoChunks(content, 2000);
    console.log(`🎙️  Generating ${chunks.length} audio chunks...\n`);

    const audioChunks = [];

    // Process in small batches to avoid overwhelming Google TTS with a burst
    // of parallel requests (which caused random 13 INTERNAL errors on Chirp).
    const CONCURRENCY = 3;
    for (let start = 0; start < chunks.length; start += CONCURRENCY) {
      const batch = chunks.slice(start, start + CONCURRENCY);
      await Promise.all(
        batch.map((chunk, offset) => {
          const index = start + offset;
          return synthesizeChunk(chunk, index)
            .then(audioBuffer => {
              audioChunks[index] = {
                index: index,
                audioBase64: audioBuffer.length > 0 ? audioBuffer.toString('base64') : '',
                textLength: chunk.length,
              };
              console.log(`✅ Chunk ${index + 1}/${chunks.length} ready`);
            })
            .catch(error => {
              console.error(`❌ Chunk ${index} failed permanently:`, error.message);
              throw error;
            });
        })
      );
    }

    audioChunks.sort((a, b) => a.index - b.index);
    const validChunks = audioChunks.filter(c => c.audioBase64 || c.audioBase64 === '');

    const estimatedDurations = chunks.map(chunkText => Math.ceil(chunkText.length / 150));

    console.log(`\n✅ All ${validChunks.length} chunks generated in ${Date.now() - startTime}ms`);

    console.log('💾 Saving to Google Drive cache...');
    const combinedAudio = Buffer.concat(
      validChunks.map(chunk => chunk.audioBase64 ? Buffer.from(chunk.audioBase64, 'base64') : Buffer.from(''))
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
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  await initializeGoogle();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 LBC Blog TTS Render Backend v4.0-CHIRP running on port ${PORT}`);
    console.log(`📍 Voice: ${VOICE_NAME}`);
    console.log(`📍 Health: http://localhost:${PORT}/health`);
    console.log(`📍 Generate: POST http://localhost:${PORT}/api/blog/generate-audio`);
    console.log(`📍 Google Drive Caching: ENABLED\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});
