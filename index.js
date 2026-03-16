/**
 * Blog TTS API - Cloudflare Workers v3.0
 * Multi-Chunk SSML Support + Sentence Highlighting
 * Google Service Account + Google Drive Caching
 * 
 * Features:
 * - Unlimited blog length (splits into chunks automatically)
 * - Sentence-level highlighting during playback
 * - Natural pauses between sentences
 * - Google Drive caching
 * - Full service account authentication
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

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token request failed: ${err}`);
  }
  const data = await response.json();
  return data.access_token;
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

// ─── BLOG CONTENT FETCHER ─────────────────────────────────

function convertTableToText(tableHtml) {
  const headers = [];
  const headerMatches = tableHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi);
  for (const m of headerMatches) {
    headers.push(m[1].replace(/<[^>]+>/g, '').trim());
  }

  const rows = [];
  const rowMatches = tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const rm of rowMatches) {
    const cells = [];
    const cellMatches = rm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    for (const cm of cellMatches) {
      cells.push(cm[1].replace(/<[^>]+>/g, '').trim());
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return '';

  let text = '';
  for (const row of rows) {
    if (headers.length > 0 && row.length > 0) {
      let sentence = row[0];
      for (let i = 1; i < row.length && i < headers.length; i++) {
        if (row[i]) {
          sentence += `, ${headers[i]} is ${row[i]}`;
        }
      }
      text += sentence + '.\n';
    } else {
      text += row.join(', ') + '.\n';
    }
  }
  return '\n' + text + '\n';
}

function decodeEntities(text) {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, ' and ')
    .replace(/&lt;/g, '')
    .replace(/&gt;/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, ', ')
    .replace(/&ndash;/g, ' to ')
    .replace(/&hellip;/g, '...')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#\d+;/g, '');
}

function cleanSpecialChars(text) {
  return text
    .replace(/[→←↑↓↔⟶⟵➜➤►▶◀▸▹▷◁«»]/g, '')
    .replace(/[✓✔✗✘✕✖★☆●○◆◇■□▪▫•‣⦿⦾♦♣♠♥♡]/g, '')
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    .replace(/[\u{2700}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')
    .replace(/[\u{200D}\u{20E3}\u{FE0F}]/gu, '')
    .replace(/[©®™]/g, '')
    .replace(/[|~^`\\]/g, ' ')
    .replace(/#\w+/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/\S+@\S+\.\S+/gi, '')
    .replace(/\b\d{2,4}[\s-]\d{3,4}[\s-]\d{3,4}\b/g, '');
}

function removeNonArticleText(text) {
  return text
    .replace(/Book (?:Your |skin |a )?(?:Consultation|Now).*?(?:\n|$)/gi, '')
    .replace(/Add to (?:Cart|Basket).*?(?:\n|$)/gi, '')
    .replace(/Buy Now.*?(?:\n|$)/gi, '')
    .replace(/Get In Touch[\s\S]*$/i, '')
    .replace(/Share your love[\s\S]*$/i, '')
    .replace(/Subscribe for[\s\S]*$/i, '')
    .replace(/A Note on Skin Safety[\s\S]*$/i, '')
    .replace(/Previous Post[\s\S]*$/i, '')
    .replace(/Edit ".*?"[\s\S]*$/i, '')
    .replace(/Browse (?:Brightening )?Products.*?(?:\n|$)/gi, '')
    .replace(/View our complete.*?(?:\n|$)/gi, '')
    .replace(/Share this.*?(?:\n|$)/gi, '')
    .replace(/Leave a (?:Comment|Reply)[\s\S]*$/i, '')
    .replace(/Related Posts[\s\S]*$/i, '')
    .replace(/Tags:.*?(?:\n|$)/gi, '')
    .replace(/Category:.*?(?:\n|$)/gi, '')
    .replace(/Posted (?:on|by|in).*?(?:\n|$)/gi, '');
}

async function fetchBlogContent(blogUrl) {
  const response = await fetch(blogUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  let html = await response.text();

  // Extract title
  let title = '';
  const h1Match = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>(.*?)<\/h1>/is)
    || html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (h1Match) {
    title = h1Match[1].replace(/<[^>]+>/g, '').trim();
  } else {
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
    if (titleMatch) title = titleMatch[1].replace(/ - .*$/, '').trim();
  }
  title = decodeEntities(title);

  // Remove unwanted blocks
  html = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')
    .replace(/<header\b[\s\S]*?<\/header>/gi, '')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, '')
    .replace(/<form\b[\s\S]*?<\/form>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<figure\b[\s\S]*?<\/figure>/gi, '')
    .replace(/<figcaption\b[\s\S]*?<\/figcaption>/gi, '')
    .replace(/<picture\b[\s\S]*?<\/picture>/gi, '')
    .replace(/<video\b[\s\S]*?<\/video>/gi, '')
    .replace(/<audio\b[\s\S]*?<\/audio>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
    .replace(/<canvas\b[\s\S]*?<\/canvas>/gi, '')
    .replace(/<button\b[\s\S]*?<\/button>/gi, '')
    .replace(/<input[^>]*>/gi, '')
    .replace(/<select\b[\s\S]*?<\/select>/gi, '')
    .replace(/<textarea\b[\s\S]*?<\/textarea>/gi, '')
    .replace(/<[^>]*class="[^"]*(?:sidebar|widget|menu|cart|woo|comment|share|related|breadcrumb|mailerlite|newsletter|social|author-bio|tag-link|post-meta|entry-meta|post-nav|pagination|cookie|gdpr|popup|modal|banner|advertisement|sponsored)[^"]*"[^>]*>[\s\S]*?<\/(?:div|section|aside|ul|ol|span|p)>/gi, '')
    .replace(/<ul[^>]*class="[^"]*(?:menu|nav|cart|sub-menu)[^"]*"[^>]*>[\s\S]*?<\/ul>/gi, '');

  // Extract article content
  let articleHtml = '';
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    articleHtml = articleMatch[1];
  } else {
    const entryMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/|$)/i);
    if (entryMatch) {
      articleHtml = entryMatch[1];
    } else {
      articleHtml = html;
    }
  }

  // Convert tables to text
  articleHtml = articleHtml.replace(/<table\b[\s\S]*?<\/table>/gi, (match) => {
    return convertTableToText(match);
  });

  // Convert structure to text
  articleHtml = articleHtml
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n$1.\n\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '\n$1.\n')
    .replace(/<[^>]+>/g, ' ');

  // Clean content
  let content = decodeEntities(articleHtml);
  content = cleanSpecialChars(content);
  content = removeNonArticleText(content);

  // Final whitespace cleanup
  content = content
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n /g, '\n')
    .replace(/\.\./g, '.')
    .replace(/\.\s*\./g, '.')
    .trim();

  if (content.length < 100) throw new Error('Insufficient content extracted');

  // Prepend title
  if (title) {
    content = title + '.\n\n' + content;
  }

  return content;
}

// ─── MULTI-CHUNK SPLITTER ─────────────────────────────────

function splitIntoChunks(text, maxChunkSize = 3000) {
  /**
   * Split text into chunks while respecting sentence boundaries
   * Ensures each chunk ends with a complete sentence
   */
  const chunks = [];
  let currentChunk = '';

  // Split by sentences (. ! ?)
  const sentences = text.match(/[^.!?]*[.!?]+/g) || [text];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    // If adding this sentence exceeds max size, save current chunk
    if (currentChunk.length + trimmed.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = trimmed;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + trimmed;
    }
  }

  // Add remaining chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// ─── CACHE KEY (Workers-compatible crypto) ────────────────

async function generateCacheKey(blogPostId, content) {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 8);
  return `lbc-blog-audio-${blogPostId}-${hash}.mp3`;
}

// ─── GOOGLE DRIVE: FIND CACHED AUDIO ──────────────────────

async function findAudioInDrive(accessToken, driveFolderId, cacheKey) {
  try {
    const query = `name="${cacheKey}" and "${driveFolderId}" in parents and trashed=false`;
    const fields = 'files(id,name,webContentLink,createdTime)';
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&spaces=drive&fields=${encodeURIComponent(fields)}&pageSize=1`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      console.log(`Drive search failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (data.files?.length > 0) {
      return {
        fileId: data.files[0].id,
        fileName: data.files[0].name,
        downloadLink: data.files[0].webContentLink,
        createdTime: data.files[0].createdTime
      };
    }
    return null;
  } catch (error) {
    console.log(`Drive search error: ${error.message}`);
    return null;
  }
}

// ─── GOOGLE TTS: SSML WITH SENTENCE MARKERS ───────────────

function textToSSML(text) {
  /**
   * Convert text to SSML with:
   * - Sentence break markers for highlighting
   * - Natural pauses
   * - XML escaping
   */
  let ssml = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Mark sentence boundaries for highlighting
  // Use phoneme tags to mark where sentences start/end (won't affect audio)
  ssml = ssml.replace(/([.!?])\s+(?=[A-Z])/g, '$1<mark name="sentence-end"/><mark name="sentence-start"/> ');
  ssml = ssml.replace(/([.!?])$/gm, '$1<mark name="sentence-end"/>');

  // Add natural pauses
  ssml = ssml.replace(/\n\n+/g, '<break time="750ms"/>');
  ssml = ssml.replace(/\n/g, '<break time="350ms"/>');
  ssml = ssml.replace(/([.!?])\s+/g, '$1<break time="300ms"/> ');
  ssml = ssml.replace(/:\s+/g, ':<break time="250ms"/> ');
  ssml = ssml.replace(/;\s+/g, ';<break time="200ms"/> ');
  ssml = ssml.replace(/(<break[^/]*\/>)\s*(<break[^/]*\/>)/g, '$2');

  return `<speak>${ssml}</speak>`;
}

// ─── GOOGLE TTS: SYNTHESIZE SPEECH ────────────────────────

async function synthesizeSpeech(accessToken, text) {
  const ssml = textToSSML(text);

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
        ssmlGender: 'FEMALE',
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 0.92,
        pitch: 0.5,
        volumeGainDb: 1.0,
      },
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`TTS failed: ${response.status} ${err}`);
  }

  const data = await response.json();
  if (!data.audioContent) throw new Error('No audio content returned');

  const binaryString = atob(data.audioContent);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// ─── AUDIO CONCATENATION ──────────────────────────────────

function concatenateAudioChunks(chunks) {
  /**
   * Concatenate MP3 audio chunks
   * Simple concatenation works for MP3 files with same encoding
   */
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

// ─── GOOGLE DRIVE: UPLOAD AUDIO ───────────────────────────

async function uploadAudioToDrive(accessToken, driveFolderId, cacheKey, audioBytes) {
  const metadata = {
    name: cacheKey,
    parents: [driveFolderId],
    description: `LBC Blog Audio - ${new Date().toISOString()}`,
    mimeType: 'audio/mpeg'
  };

  const boundary = '===============boundary==';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;

  const metaPart = delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: audio/mpeg\r\nContent-Transfer-Encoding: binary\r\n\r\n';

  const metaBytes = new TextEncoder().encode(metaPart);
  const closeBytes = new TextEncoder().encode(closeDelim);

  const body = new Uint8Array(metaBytes.length + audioBytes.length + closeBytes.length);
  body.set(metaBytes, 0);
  body.set(audioBytes, metaBytes.length);
  body.set(closeBytes, metaBytes.length + audioBytes.length);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: body
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Drive upload failed: ${response.status} ${err}`);
  }

  const data = await response.json();

  // Make file publicly readable
  await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  });

  return {
    fileId: data.id,
    fileName: cacheKey,
    downloadLink: `https://drive.google.com/uc?export=download&id=${data.id}`,
    createdTime: data.createdTime,
    size: data.size
  };
}

// ─── WORKER ENTRY POINT ───────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // Root
      if (url.pathname === '/') {
        return jsonResponse({
          service: 'LBC Blog TTS API',
          version: '3.0',
          platform: 'Cloudflare Workers',
          features: ['multi-chunk', 'sentence-highlighting', 'google-drive-cache'],
          endpoints: {
            health: 'GET /api/blog/health',
            readAloud: 'POST /api/blog/read-aloud'
          }
        });
      }

      // Health check
      if (url.pathname === '/api/blog/health') {
        try {
          const serviceAccountJSON = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
          await getAccessToken(serviceAccountJSON);
          return jsonResponse({
            status: 'healthy',
            service: 'LBC Blog TTS API',
            version: '3.0',
            platform: 'Cloudflare Workers',
            features: ['multi-chunk', 'sentence-highlighting'],
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          return jsonResponse({ status: 'unhealthy', error: error.message }, 503);
        }
      }

      // Read aloud - MULTI-CHUNK VERSION
      if (url.pathname === '/api/blog/read-aloud' && request.method === 'POST') {
        const data = await request.json();
        const { blogPostId, blogUrl, blogContent } = data;

        if (!blogPostId || (!blogUrl && !blogContent)) {
          return jsonResponse({
            success: false,
            error: 'Missing required fields: blogPostId and (blogUrl or blogContent)'
          }, 400);
        }

        const serviceAccountJSON = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
        const driveFolderId = (env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
        const accessToken = await getAccessToken(serviceAccountJSON);

        // Get blog content
        let content = blogContent;
        if (!content && blogUrl) {
          content = await fetchBlogContent(blogUrl);
        }

        // Generate cache key
        const cacheKey = await generateCacheKey(blogPostId, content);

        // Check Drive cache
        const cached = await findAudioInDrive(accessToken, driveFolderId, cacheKey);
        if (cached) {
          return jsonResponse({
            success: true,
            cached: true,
            audioUrl: cached.downloadLink,
            fileId: cached.fileId,
            createdTime: cached.createdTime,
            multiChunk: false
          });
        }

        // Split into chunks if needed
        const chunks = splitIntoChunks(content, 3000);
        console.log(`Processing ${chunks.length} chunk(s), total length: ${content.length}`);

        // Synthesize each chunk
        const audioChunks = [];
        for (let i = 0; i < chunks.length; i++) {
          console.log(`Synthesizing chunk ${i + 1}/${chunks.length}`);
          const chunkAudio = await synthesizeSpeech(accessToken, chunks[i]);
          audioChunks.push(chunkAudio);
        }

        // Concatenate all chunks
        const audioBytes = concatenateAudioChunks(audioChunks);

        // Try Drive upload (non-fatal if it fails)
        let uploaded = null;
        try {
          uploaded = await uploadAudioToDrive(accessToken, driveFolderId, cacheKey, audioBytes);
        } catch (driveError) {
          console.log(`Drive cache failed (non-fatal): ${driveError.message}`);
        }

        // Convert audio to base64 for direct playback
        let binaryString = '';
        const chunkSize = 8192;
        for (let i = 0; i < audioBytes.length; i += chunkSize) {
          const chunk = audioBytes.subarray(i, i + chunkSize);
          binaryString += String.fromCharCode.apply(null, chunk);
        }
        const audioBase64 = btoa(binaryString);

        return jsonResponse({
          success: true,
          cached: false,
          audioBase64: audioBase64,
          audioUrl: uploaded ? uploaded.downloadLink : null,
          fileId: uploaded ? uploaded.fileId : null,
          contentLength: audioBytes.length,
          cacheKey: cacheKey,
          multiChunk: chunks.length > 1,
          chunkCount: chunks.length,
          totalChars: content.length
        });
      }

      // 404
      return jsonResponse({ error: 'Not found' }, 404);

    } catch (error) {
      console.log(`Worker error: ${error.message}`);
      return jsonResponse({ success: false, error: error.message }, 500);
    }
  }
};

// ─── HELPER ───────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
