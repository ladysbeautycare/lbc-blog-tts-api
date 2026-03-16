/**
 * Blog TTS API - Cloudflare Workers v4.1 FIXED
 * Multi-chunk: Generate audio chunks separately
 * Better error handling & logging
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── JWT & AUTH ───────────────────────────────────────────

async function getAccessToken(serviceAccountJSON) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccountJSON.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
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

  if (!response.ok) throw new Error('Auth failed');
  return (await response.json()).access_token;
}

function base64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function signJWT(header, payload, privateKey) {
  const headerEnc = base64url(JSON.stringify(header));
  const payloadEnc = base64url(JSON.stringify(payload));
  const message = `${headerEnc}.${payloadEnc}`;

  const keyData = privateKey.replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\n/g, '');
  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey('pkcs8', binaryKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(message));
  const signatureEnc = base64url(String.fromCharCode(...new Uint8Array(signature)));

  return `${message}.${signatureEnc}`;
}

// ─── FETCH BLOG CONTENT ───────────────────────────────────

async function fetchBlogContent(blogUrl) {
  const response = await fetch(blogUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error('Fetch failed');

  let html = await response.text();

  let title = '';
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  if (titleMatch) title = titleMatch[1].split('|')[0].trim();

  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<nav\b[\s\S]*?<\/nav>/gi, '').replace(/<footer\b[\s\S]*?<\/footer>/gi, '').replace(/<img[^>]*>/gi, '');

  let content = '';
  const entryMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (entryMatch) content = entryMatch[1];
  else {
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) content = articleMatch[1];
  }

  let text = content
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n$1\n\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '\n$1\n')
    .replace(/<ul[^>]*>|<\/ul>|<ol[^>]*>|<\/ol>/gi, '\n')
    .replace(/<div[^>]*>|<\/div>/gi, '\n')
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

  return text;
}

// ─── SPLIT INTO CHUNKS ────────────────────────────────────

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

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ─── TEXT TO SSML ─────────────────────────────────────────

function textToSSML(text) {
  let ssml = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  ssml = ssml.replace(/\n\n+/g, '<break time="800ms"/>').replace(/\n/g, '<break time="400ms"/>').replace(/([.!?])\s+/g, '$1<break time="350ms"/> ').replace(/:\s+/g, ':<break time="300ms"/> ');
  return `<speak>${ssml}</speak>`;
}

// ─── SYNTHESIZE ONE CHUNK ────────────────────────────────

async function synthesizeChunk(accessToken, text) {
  const ssml = textToSSML(text);
  const ssmlSize = new TextEncoder().encode(ssml).length;

  if (ssmlSize > 4800) throw new Error('Chunk SSML too large');

  const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: { ssml },
      voice: { languageCode: 'en-AU', name: 'en-AU-Neural2-C' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 0.92 },
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`TTS ${response.status}: ${errText.substring(0, 100)}`);
  }

  const data = await response.json();
  if (!data.audioContent) throw new Error('No audio content');

  return data.audioContent;
}

// ─── WORKER ENTRY ─────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (url.pathname === '/') {
        return jsonResponse({ service: 'LBC Blog TTS API', version: '4.1', features: ['unlimited-blogs', 'multi-chunk'] });
      }

      if (url.pathname === '/api/blog/health') {
        const serviceAccountJSON = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
        await getAccessToken(serviceAccountJSON);
        return jsonResponse({ status: 'healthy', version: '4.1' });
      }

      if (url.pathname === '/api/blog/read-aloud' && request.method === 'POST') {
        const data = await request.json();
        const { blogPostId, blogUrl, blogContent } = data;

        if (!blogPostId || (!blogUrl && !blogContent)) {
          return jsonResponse({ success: false, error: 'Missing parameters' }, 400);
        }

        const serviceAccountJSON = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
        const accessToken = await getAccessToken(serviceAccountJSON);

        let content = blogContent;
        if (!content && blogUrl) {
          content = await fetchBlogContent(blogUrl);
        }

        const chunks = splitIntoChunks(content, 2000);
        console.log(`Processing ${chunks.length} chunks`);

        const audioChunks = [];
        for (let i = 0; i < chunks.length; i++) {
          const audioBase64 = await synthesizeChunk(accessToken, chunks[i]);
          audioChunks.push({
            index: i,
            audioBase64: audioBase64,
            textLength: chunks[i].length
          });
        }

        return jsonResponse({
          success: true,
          audioChunks: audioChunks,
          totalChunks: audioChunks.length,
          totalChars: content.length
        });
      }

      return jsonResponse({ error: 'Not found' }, 404);

    } catch (error) {
      console.error('Error:', error.message);
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
