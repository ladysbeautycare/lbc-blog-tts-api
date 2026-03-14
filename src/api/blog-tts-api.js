// =============================================================
// BLOG TTS API — COMPLETE & WORKING
// =============================================================
// Secure Text-to-Speech system with Google Drive caching
// Uses Workload Identity Federation (no JSON keys)
//
// Environment Variables:
//   GOOGLE_PROJECT_ID
//   GOOGLE_WORKLOAD_IDENTITY_PROVIDER
//   GOOGLE_DRIVE_FOLDER_ID
// =============================================================

const express = require("express");
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// ─── LOGGING ──────────────────────────────────────────────
const log = {
  info: (msg, data = {}) => console.log(`[INFO] ${msg}`, data),
  error: (msg, err = {}) => console.error(`[ERROR] ${msg}`, err),
};

// ─── INITIALIZE GOOGLE CLIENTS ────────────────────────────
let ttsClient = null;
let driveClient = null;

async function initializeGoogleClients() {
  if (ttsClient && driveClient) return;

  try {
    const auth = new GoogleAuth({
      projectId: process.env.GOOGLE_PROJECT_ID,
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/texttospeech"
      ]
    });

    ttsClient = new TextToSpeechClient({
      projectId: process.env.GOOGLE_PROJECT_ID,
      auth: auth
    });

    driveClient = google.drive({
      version: "v3",
      auth: auth
    });

    log.info("✓ Google clients initialized");
  } catch (error) {
    log.error("Failed to initialize Google clients", error.message);
    throw error;
  }
}

// ─── FETCH BLOG CONTENT ────────────────────────────────────
async function fetchBlogContent(blogUrl) {
  try {
    const response = await axios.get(blogUrl, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(response.data);
    $("script, style, nav, .sidebar, .comments").remove();

    let content = $("article, .post-content, .entry-content, main").text();
    if (!content) content = $("body").text();

    content = content
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 8000);

    return content.length > 100 ? content : null;
  } catch (error) {
    log.error("Blog fetch error", error.message);
    return null;
  }
}

// ─── GENERATE CACHE KEY ───────────────────────────────────
function generateCacheKey(blogPostId, content) {
  const hash = crypto
    .createHash("sha256")
    .update(content)
    .digest("hex")
    .substring(0, 8);
  return `lbc-blog-audio-${blogPostId}-${hash}.mp3`;
}

// ─── CHECK IF AUDIO EXISTS IN GOOGLE DRIVE ────────────────
async function findAudioInDrive(cacheKey) {
  try {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) return null;

    await initializeGoogleClients();

    const response = await driveClient.files.list({
      q: `name="${cacheKey}" and "${folderId}" in parents and trashed=false`,
      spaces: "drive",
      fields: "files(id, name, webContentLink)",
      pageSize: 1,
    });

    if (response.data.files && response.data.files.length > 0) {
      const file = response.data.files[0];
      log.info("✓ Found cached audio", { fileName: cacheKey });
      return {
        fileId: file.id,
        fileName: file.name,
        downloadLink: file.webContentLink,
      };
    }

    return null;
  } catch (error) {
    log.error("Drive search error", error.message);
    return null;
  }
}

// ─── SYNTHESIZE SPEECH VIA GOOGLE TTS ──────────────────────
async function synthesizeSpeech(text) {
  try {
    await initializeGoogleClients();

    const request = {
      input: { text: text },
      voice: {
        languageCode: "en-AU",
        name: "en-AU-Neural2-C",
        ssmlGender: "FEMALE",
      },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: 0.95,
        pitch: 0.0,
        volumeGainDb: 0.0,
      },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);

    if (!response.audioContent) {
      throw new Error("No audio content returned");
    }

    log.info("✓ Audio synthesized", { size: response.audioContent.length });
    return response.audioContent;
  } catch (error) {
    log.error("TTS synthesis error", error.message);
    throw error;
  }
}

// ─── UPLOAD AUDIO TO GOOGLE DRIVE ─────────────────────────
async function uploadAudioToDrive(cacheKey, audioBuffer) {
  try {
    await initializeGoogleClients();

    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) {
      throw new Error("GOOGLE_DRIVE_FOLDER_ID not set");
    }

    const file = {
      name: cacheKey,
      parents: [folderId],
      description: `LBC Blog Audio - ${new Date().toISOString()}`,
    };

    const response = await driveClient.files.create({
      resource: file,
      media: {
        mimeType: "audio/mpeg",
        body: audioBuffer,
      },
      fields: "id, webContentLink",
    });

    log.info("✓ Audio uploaded to Drive", { fileId: response.data.id });

    return {
      fileId: response.data.id,
      fileName: cacheKey,
      downloadLink: response.data.webContentLink,
    };
  } catch (error) {
    log.error("Drive upload error", error.message);
    throw error;
  }
}

// ─── MAIN ENDPOINT: READ BLOG ALOUD ────────────────────────
app.post("/api/blog/read-aloud", async (req, res) => {
  try {
    const { blogPostId, blogUrl, blogContent } = req.body;

    if (!blogPostId || (!blogUrl && !blogContent)) {
      return res.status(400).json({
        error: "Missing blogPostId and (blogUrl or blogContent)"
      });
    }

    let content = blogContent;
    if (!content && blogUrl) {
      content = await fetchBlogContent(blogUrl);
      if (!content) {
        return res.status(400).json({
          error: "Could not fetch blog content"
        });
      }
    }

    const cacheKey = generateCacheKey(blogPostId, content);

    // Check cache first
    const cachedAudio = await findAudioInDrive(cacheKey);
    if (cachedAudio) {
      return res.json({
        success: true,
        cached: true,
        audioUrl: cachedAudio.downloadLink,
        fileId: cachedAudio.fileId,
        message: "Cached audio (no API charge)"
      });
    }

    // Generate new audio
    const audioBuffer = await synthesizeSpeech(content);

    // Upload to Drive for caching
    const uploadedFile = await uploadAudioToDrive(cacheKey, audioBuffer);

    return res.json({
      success: true,
      cached: false,
      audioUrl: uploadedFile.downloadLink,
      fileId: uploadedFile.fileId,
      message: "New audio generated and cached"
    });

  } catch (error) {
    log.error("Read aloud endpoint error", error.message);
    return res.status(500).json({
      error: "Failed to generate audio",
      message: error.message
    });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get("/api/blog/health", (req, res) => {
  res.json({ status: "TTS system ready" });
});

// ─── ROOT ENDPOINT ────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ 
    service: "LBC Blog TTS API",
    status: "running",
    endpoints: {
      health: "GET /api/blog/health",
      readAloud: "POST /api/blog/read-aloud"
    }
  });
});

// ─── ERROR HANDLER ────────────────────────────────────────
app.use((err, req, res, next) => {
  log.error("Unhandled error", err.message);
  res.status(500).json({
    error: "Internal server error",
    message: err.message
  });
});

// ─── START SERVER ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  log.info(`✓ Blog TTS API listening on port ${PORT}`);
  log.info(`✓ Ready to accept requests`);
});

module.exports = app;