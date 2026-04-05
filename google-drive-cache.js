/**
 * Google Drive Cache Module - FIXED
 * Stores generated audio files on Google Drive for cost savings
 * Uses direct Buffer upload instead of pipe()
 */

const { google } = require('googleapis');
const crypto = require('crypto');

class GoogleDriveCache {
  constructor(serviceAccountJson, workspaceUserEmail, driveFolderId) {
    this.serviceAccountJson = serviceAccountJson;
    this.workspaceUserEmail = workspaceUserEmail;
    this.driveFolderId = driveFolderId;
    this.authClient = null;
    this.drive = null;
    this.memoryCache = new Map();
    this.cacheTTL = 24 * 60 * 60 * 1000; // 24 hours
  }

  async initialize() {
    try {
      // Create JWT auth with Domain-Wide Delegation
      this.authClient = new google.auth.JWT({
        email: this.serviceAccountJson.client_email,
        key: this.serviceAccountJson.private_key,
        scopes: [
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/drive.readonly',
        ],
        subject: this.workspaceUserEmail,
      });

      // Test auth
      await this.authClient.authorize();

      // Initialize Drive API
      this.drive = google.drive({
        version: 'v3',
        auth: this.authClient,
      });

      console.log('✅ Google Drive Cache initialized (Domain-Wide Delegation)');
    } catch (error) {
      console.error('❌ Google Drive Cache init failed:', error.message);
      throw error;
    }
  }

  generateContentHash(text) {
    return crypto
      .createHash('sha256')
      .update(text)
      .digest('hex')
      .substring(0, 12);
  }

  async getCachedAudio(contentHash, postId) {
    try {
      const cacheKey = `blog_post_${postId}_${contentHash}.mp3`;

      // Check memory cache first (fast)
      if (this.memoryCache.has(cacheKey)) {
        const cached = this.memoryCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTTL) {
          console.log(`💾 Memory cache HIT: ${cacheKey}`);
          return cached.data;
        } else {
          this.memoryCache.delete(cacheKey);
        }
      }

      // Check Drive (slower)
      const query = `name='${cacheKey}' and parents='${this.driveFolderId}' and trashed=false`;
      const response = await this.drive.files.list({
        q: query,
        spaces: 'drive',
        fields: 'files(id, name, size)',
        pageSize: 1,
      });

      if (response.data.files && response.data.files.length > 0) {
        const file = response.data.files[0];
        console.log(`💾 Drive cache HIT: ${file.name} (${file.size} bytes)`);

        // Download the file
        const downloadResponse = await this.drive.files.get(
          { fileId: file.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );

        const audioBuffer = Buffer.from(downloadResponse.data);

        // Cache in memory for next 24 hours
        this.memoryCache.set(cacheKey, {
          data: audioBuffer,
          timestamp: Date.now(),
        });

        return audioBuffer;
      }

      console.log(`⏭️  Cache MISS: ${cacheKey}`);
      return null;
    } catch (error) {
      console.error(`⚠️  Cache read error: ${error.message}`);
      return null; // Graceful fallback
    }
  }

  async saveAudioCache(audioBuffer, contentHash, postId) {
    try {
      if (!Buffer.isBuffer(audioBuffer)) {
        throw new Error('audioBuffer must be a Buffer');
      }

      const cacheKey = `blog_post_${postId}_${contentHash}.mp3`;

      console.log(`💾 Saving to Drive: ${cacheKey} (${audioBuffer.length} bytes)`);

      // Create file metadata
      const fileMetadata = {
        name: cacheKey,
        parents: [this.driveFolderId],
        mimeType: 'audio/mpeg',
      };

      // Upload using Buffer (NO PIPE)
      const response = await this.drive.files.create({
        resource: fileMetadata,
        media: {
          mimeType: 'audio/mpeg',
          body: audioBuffer, // Direct Buffer, not a stream
        },
        fields: 'id, name, size',
      });

      console.log(`✅ Cached to Drive: ${response.data.name} (ID: ${response.data.id})`);

      // Also cache in memory
      this.memoryCache.set(cacheKey, {
        data: audioBuffer,
        timestamp: Date.now(),
      });

      return response.data.id;
    } catch (error) {
      console.error(`⚠️  Cache save error: ${error.message}`);
      // Don't throw - caching is optional
      return null;
    }
  }

  async cleanupOldCache(daysOld = 7) {
    try {
      const cutoffTime = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

      const query = `parents='${this.driveFolderId}' and createdTime<'${cutoffTime.toISOString()}' and trashed=false`;
      const response = await this.drive.files.list({
        q: query,
        spaces: 'drive',
        fields: 'files(id, name)',
      });

      if (response.data.files && response.data.files.length > 0) {
        console.log(`🗑️  Cleaning up ${response.data.files.length} old cache files...`);

        for (const file of response.data.files) {
          await this.drive.files.delete({ fileId: file.id });
          console.log(`  ✓ Deleted: ${file.name}`);
        }

        console.log(`✅ Cleanup complete`);
      } else {
        console.log(`✅ No old cache files to delete`);
      }
    } catch (error) {
      console.error(`⚠️  Cleanup error: ${error.message}`);
    }
  }
}

module.exports = GoogleDriveCache;
