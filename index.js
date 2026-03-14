/**
 * Blog TTS API - Cloudflare Workers
 * Enterprise-grade text-to-speech with WIF
 * 
 * Environment Variables (required):
 *   GOOGLE_PROJECT_ID
 *   GOOGLE_WORKLOAD_IDENTITY_PROVIDER
 *   GOOGLE_DRIVE_FOLDER_ID
 */

import { GoogleAuth } from 'google-auth-library';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { google } from 'googleapis';
import crypto from 'crypto';

// ─── ENVIRONMENT ───────────────────────────────────────
let ENV = null;

function initializeENV(env) {
  if (ENV) return;
  
  ENV = {
    PROJECT_ID: env.GOOGLE_PROJECT_ID,
    WIF_PROVIDER: env.GOOGLE_WORKLOAD_IDENTITY_PROVIDER,
    DRIVE_FOLDER_ID: env.GOOGLE_DRIVE_FOLDER_ID,
  };
}

// ─── VALIDATE ENV ──────────────────────────────────────
function validateEnv() {
  const required = ['PROJECT_ID', 'WIF_PROVIDER', 'DRIVE_FOLDER_ID'];
  const missing = required.filter(k => !ENV[k]);
  
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(', ')}`);
  }
}

// ─── GOOGLE CLIENTS (CACHED) ───────────────────────────
let authClient = null;
let ttsClient = null;
let driveClient = null;

async function initializeClients() {
  if (authClient && ttsClient && driveClient) {
    return;
  }

  validateEnv();

  try {
    // Create auth with WIF
    authClient = new GoogleAuth({
      projectId: ENV.PROJECT_ID,
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/texttospeech'
      ]
    });

    ttsClient = new TextToSpeechClient({
      projectId: ENV.PROJECT_ID,
      auth: authClient
    });

    driveClient = google.drive({
      version: 'v3',
      auth: authClient
    });

    console.log('✓ Google Cloud clients initialized with WIF');
  } catch (error) {
    console.error('Failed to initialize clients:', error.message);
    throw error;
  }
}

// ─── FETCH BLOG CONTENT ────────────────────────────────
async function fetchBlogContent(blogUrl) {
  try {
    const response = await fetch(blogUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    
    // Simple HTML parsing (Cloudflare Workers don't have cheerio, so we use regex)
    // Remove scripts, styles, nav, footer
    let content = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '');

    // Extract text from main content areas
    const mainMatch = content.match(/<(article|main|div[^>]*class="[^"]*content[^"]*"[^>]*)>(.+?)<\/\1>/is);
    if (mainMatch) {
      content = mainMatch[2];
    }

    // Strip HTML tags
    content = content
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 4500); // Limit for TTS API

    if (content.length < 100) {
      throw new Error('Insufficient content extracted');
    }

    return content;
  } catch (error) {
    throw new Error(`Failed to fetch blog: ${error.message}`);
  }
}

// ─── GENERATE CACHE KEY ────────────────────────────────
function generateCacheKey(blogPostId, content) {
  const hash = crypto
    .createHash('sha256')
    .update(content)
    .digest('hex')
    .substring(0, 8);
  return `lbc-blog-audio-${blogPostId}-${hash}.mp3`;
}

// ─── FIND AUDIO IN DRIVE ───────────────────────────────
async function findAudioInDrive(cacheKey) {
  try {
    await initializeClients();

    const response = await driveClient.files.list({
      q: `name="${cacheKey}" and "${ENV.DRIVE_FOLDER_ID}" in parents and trashed=false`,
      spaces: 'drive',
      fields: 'files(id, name, webContentLink, createdTime)',
      pageSize: 1,
    });

    if (response.data.files && response.data.files.length > 0) {
      const file = response.data.files[0];
      console.log(`✓ Cache hit: ${cacheKey}`);
      
      return {
        fileId: file.id,
        fileName: file.name,
        downloadLink: file.webContentLink,
        createdTime: file.createdTime
      };
    }

    return null;
  } catch (error) {
    console.warn(`Cache lookup failed: ${error.message}`);
    return null;
  }
}

// ─── SYNTHESIZE SPEECH ─────────────────────────────────
async function synthesizeSpeech(text) {
  try {
    await initializeClients();

    const request = {
      input: { text: text },
      voice: {
        languageCode: 'en-AU',
        name: 'en-AU-Neural2-C',
        ssmlGender: 'FEMALE',
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 0.95,
        pitch: 0.0,
        volumeGainDb: 0.0,
      },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);

    if (!response.audioContent) {
      throw new Error('No audio content returned');
    }

    console.log(`✓ Audio synthesized: ${response.audioContent.length} bytes`);
    return response.audioContent;
  } catch (error) {
    throw new Error(`TTS synthesis failed: ${error.message}`);
  }
}

// ─── UPLOAD TO DRIVE ───────────────────────────────────
async function uploadAudioToDrive(cacheKey, audioBuffer) {
  try {
    await initializeClients();

    const file = {
      name: cacheKey,
      parents: [ENV.DRIVE_FOLDER_ID],
      description: `LBC Blog Audio - ${new Date().toISOString()}`,
      mimeType: 'audio/mpeg'
    };

    const response = await driveClient.files.create({
      resource: file,
      media: {
        mimeType: 'audio/mpeg',
        body: audioBuffer,
      },
      fields: 'id, webContentLink, createdTime, size',
    });

    console.log(`✓ Audio uploaded: ${response.data.id}`);

    return {
      fileId: response.data.id,
      fileName: cacheKey,
      downloadLink: response.data.webContentLink,
      createdTime: response.data.createdTime,
      size: response.data.size
    };
  } catch (error) {
    throw new Error(`Drive upload failed: ${error.message}`);
  }
}

// ─── INPUT VALIDATION ──────────────────────────────────
function validateInput(blogPostId, blogUrl, blogContent) {
  const errors = [];

  if (!blogPostId || typeof blogPostId !== 'string') {
    errors.push('blogPostId required');
  }

  if (!blogUrl && !blogContent) {
    errors.push('blogUrl or blogContent required');
  }

  if (blogContent && blogContent.length < 100) {
    errors.push('blogContent must be 100+ chars');
  }

  return errors;
}

// ─── CORS HEADERS ──────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ─── MAIN ENDPOINT ─────────────────────────────────────
async function handleReadAloud(request) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const startTime = Date.now();

  try {
    const data = await request.json();
    const { blogPostId, blogUrl, blogContent } = data;

    // Validate
    const errors = validateInput(blogPostId, blogUrl, blogContent);
    if (errors.length > 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid input',
        details: errors,
        requestId
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    console.log(`[${requestId}] Processing: ${blogPostId}`);

    // Fetch content if needed
    let content = blogContent;
    if (!content && blogUrl) {
      content = await fetchBlogContent(blogUrl);
    }

    // Generate cache key
    const cacheKey = generateCacheKey(blogPostId, content);
    console.log(`[${requestId}] Cache key: ${cacheKey}`);

    // Check cache
    const cached = await findAudioInDrive(cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;
      return new Response(JSON.stringify({
        success: true,
        cached: true,
        audioUrl: cached.downloadLink,
        fileId: cached.fileId,
        createdTime: cached.createdTime,
        message: 'Cached audio',
        requestId,
        duration
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // Generate audio
    console.log(`[${requestId}] Generating audio`);
    const audioBuffer = await synthesizeSpeech(content);

    // Upload
    console.log(`[${requestId}] Uploading to Drive`);
    const uploaded = await uploadAudioToDrive(cacheKey, audioBuffer);

    const duration = Date.now() - startTime;
    console.log(`[${requestId}] Complete: ${duration}ms`);

    return new Response(JSON.stringify({
      success: true,
      cached: false,
      audioUrl: uploaded.downloadLink,
      fileId: uploaded.fileId,
      createdTime: uploaded.createdTime,
      size: uploaded.size,
      message: 'New audio generated',
      requestId,
      duration
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${requestId}] Error: ${error.message}`);

    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      requestId,
      duration
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

// ─── HEALTH CHECK ─────────────────────────────────────
async function handleHealth(request) {
  try {
    await initializeClients();
    
    return new Response(JSON.stringify({
      status: 'healthy',
      service: 'LBC Blog TTS API',
      version: '1.0.0',
      platform: 'Cloudflare Workers',
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      status: 'unhealthy',
      error: error.message
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

// ─── ROOT ─────────────────────────────────────────────
function handleRoot(request) {
  return new Response(JSON.stringify({
    service: 'LBC Blog TTS API',
    platform: 'Cloudflare Workers',
    version: '1.0.0',
    endpoints: {
      health: 'GET /api/blog/health',
      readAloud: 'POST /api/blog/read-aloud'
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// ─── ROUTER ───────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    // Initialize ENV from Cloudflare bindings
    initializeENV(env);

    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response('OK', {
        status: 204,
        headers: corsHeaders()
      });
    }

    // Routes
    if (url.pathname === '/') {
      return handleRoot(request);
    }

    if (url.pathname === '/api/blog/health' && request.method === 'GET') {
      return await handleHealth(request);
    }

    if (url.pathname === '/api/blog/read-aloud' && request.method === 'POST') {
      return await handleReadAloud(request);
    }

    // 404
    return new Response(JSON.stringify({
      error: 'Not found',
      path: url.pathname
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
};