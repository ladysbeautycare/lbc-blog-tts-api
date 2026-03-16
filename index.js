/**
 * Blog TTS API - Cloudflare Workers v4.0
 * Multi-chunk approach: Return array of chunks for frontend to play sequentially
 * Handles blogs 25,000+ characters
 * No MP3 concatenation issues
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── JWT & AUTH ───────────────────────────────────────────

async function getAccessToken(serviceAccountJSON) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: serviceAccountJSON.client_email,
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    const jwt = await signJWT(header, payload, serviceAccountJSON.private_key);

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString(),
    });

    if (!response.ok) throw new Error(`Token failed: ${response.status}`);
    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error('Auth error:', error.message);
    throw error;
  }
}

function base64url(str) {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function signJWT(header, payload, privateKey) {
  const headerEncoded = base64url(JSON.stringify(header));
  const payloadEncoded = base64url(JSON.stringify(payload));
  const message = `${headerEncoded}.${payloadEncoded}`;

  const keyData = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\n/g, '');
  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(message)
  );
  const signatureEncoded = base64url(String.fromCharCode(...new Uint8Array(signature)));

  return `${message}.${signatureEncoded}`;
}

// ─── FETCH & EXTRACT BLOG CONTENT ─────────────────────────

async function fetchBlogContent(blogUrl) {
  try {
    const response = await fetch(blogUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    let html = await response.text();

    // Extract title
    let title = '';
    const titleMatch = html.match(/<h1[^>]*class="[^"]*post-title[^"]*"[^>]*>(.*?)<\/h1>/is)
      || html.match(/<title[^>]*>(.*?)<\/title>/is);
    if (titleMatch) {
      title = titleMatch[1].replace(/<[^>]+>/g, '').split('|')[0].trim();
    }

    // Remove unwanted elements
    html = html
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer\b[\s\S]*?<\/footer>/gi, '')
      .replace(/<img[^>]*>/gi, '')
      .replace(/<figure\b[\s\S]*?<\/figure>/gi, '');

    // Extract entry-content
    let content = '';
    const entryMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    
    if (entryMatch) {
      content = entryMatch[1];
    } else {
      const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
      if (articleMatch) {
        content = articleMatch[1];
      }
    }

    // Convert HTML to text
    let text = content
      .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n$1\n\n')
      .replace(/<p[^>]*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>(.*?)<\/li>/gi, '\n• $1\n')
      .replace(/<ul[^>]*>|<\/ul>/gi, '\n')
      .replace(/<ol[^>]*>|<\/ol>/gi, '\n')
      .replace(/<div[^>]*>|<\/div>/gi, '\n')
      .replace(/<span[^>]*>(.*?)<\/span>/gi, '$1')
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '$1')
      .replace(/<em[^>]*>(.*?)<\/em>/gi, '$1')
      .replace(/<a[^>]*>(.*?)<\/a>/gi, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, ' and ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();

    if (text.length < 100) throw new Error('Content too short');
    if (title) text = title + '.\n\n' + text;

    console.log(`Extracted ${text.length} chars from blog`);
    return text;
  } catch (error) {
    console.error('Fetch error:', error.message);
    throw error;
  }
}

// ─── SPLIT INTO CHUNKS (SMART) ────────────────────────────

function splitIntoChunks(text, maxChunkSize = 2000) {
  /**
   * Split text into chunks respecting sentence boundaries
   * Each chunk ~2000 chars to stay well under 5000-byte SSML limit
   */
  const chunks = [];
  let currentChunk = '';

  // Split by sentences
  const sentences = text.match(/[^.!?]*[.!?]+/g) || [text];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if (currentChunk.length + trimmed.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = trimmed;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + trimmed;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  console.log(`Split into ${chunks.length} chunks`);
  return chunks;
}

// ─── TEXT TO SSML ─────────────────────────────────────────

function textToSSML(text) {
  let ssml = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  ssml = ssml.replace(/\n\n+/g, '<break time="800ms"/>');
  ssml = ssml.replace(/\n/g, '<break time="400ms"/>');
  ssml = ssml.replace(/([.!?])\s+/g, '$1<break time="350ms"/> ');
  ssml = ssml.replace(/:\s+/g, ':<break time="300ms"/> ');

  return `<speak>${ssml}</speak>`;
}

// ─── SYNTHESIZE ONE CHUNK ────────────────────────────────

async function synthesizeSpeech(accessToken, text) {
  try {
    const ssml = textToSSML(text);
    const ssmlBytes = new TextEncoder().encode(ssml);
    
    if (ssmlBytes.length > 4800) {
      throw new Error(`SSML too large: ${ssmlBytes.length} bytes`);
    }

    const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: { ssml },
        voice: {
          languageCode: 'en-AU',
          name: 'en-AU-Neural2-C',
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 0.92,
        },
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`TTS ${response.status}`);
    }

    const data = await response.json();
    if (!data.audioContent) throw new Error('No audio');

    return data.audioContent; // Return base64 directly
  } catch (error) {
    console.error('TTS error:', error.message);
    throw error;
  }
}

// ─── WORKER ENTRY POINT ───────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (url.pathname === '/') {
        return jsonResponse({
          service: 'LBC Blog TTS API',
          version: '4.0',
          features: ['unlimited-blog-length', 'multi-chunk-sequential', 'no-mp3-concat']
        });
      }

      if (url.pathname === '/api/blog/health') {
        try {
          const serviceAccountJSON = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
          await getAccessToken(serviceAccountJSON);
          return jsonResponse({ status: 'healthy', version: '4.0' });
        } catch (error) {
          return jsonResponse({ status: 'unhealthy', error: error.message }, 503);
        }
      }

      if (url.pathname === '/api/blog/read-aloud' && request.method === 'POST') {
        const data = await request.json();
        const { blogPostId, blogUrl, blogContent } = data;

        if (!blogPostId || (!blogUrl && !blogContent)) {
          return jsonResponse({ success: false, error: 'Missing parameters' }, 400);
        }

        const serviceAccountJSON = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
        const accessToken = await getAccessToken(serviceAccountJSON);

        // Get content
        let content = blogContent;
        if (!content && blogUrl) {
          content = await fetchBlogContent(blogUrl);
        }

        // Split into chunks
        const textChunks = splitIntoChunks(content, 2000);
        console.log(`Processing ${textChunks.length} chunks for ${content.length} chars`);

        // Generate audio chunks
        const audioChunks = [];
        for (let i = 0; i < textChunks.length; i++) {
          try {
            console.log(`Chunk ${i + 1}/${textChunks.length}`);
            const audioBase64 = await synthesizeSpeech(accessToken, textChunks[i]);
            audioChunks.push({
              index: i,
              audioBase64: audioBase64,
              textLength: textChunks[i].length
            });
          } catch (chunkError) {
            console.error(`Chunk ${i} failed:`, chunkError.message);
            throw chunkError;
          }
        }

        return jsonResponse({
          success: true,
          cached: false,
          audioChunks: audioChunks,
          totalChunks: audioChunks.length,
          totalChars: content.length,
          playbackMode: 'sequential'
        });
      }

      return jsonResponse({ error: 'Not found' }, 404);

    } catch (error) {
      console.error('Worker error:', error.message);
      return jsonResponse({ success: false, error: error.message }, 500);
    }
  }
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
