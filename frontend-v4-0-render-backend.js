/**
 * LBC Blog TTS Frontend v4.0
 * Works with Render backend
 * Handles multi-chunk sequential playback
 * Sentence highlighting across chunks
 */

document.addEventListener('DOMContentLoaded', function() {
  const button = document.getElementById('lbc-read-button');
  const status = document.getElementById('lbc-tts-status');
  const audio = document.getElementById('lbc-tts-audio');
  
  if (!button || !lbcTTS) {
    console.warn('LBC TTS: Required elements missing');
    return;
  }

  let isPlaying = false;
  let audioChunks = [];
  let currentChunkIndex = 0;
  let sentences = [];
  let sentenceTimings = [];

  // ─── EXTRACT SENTENCES ────────────────────────────────
  function extractSentences() {
    const articleContent = document.querySelector('article, .post-content, .entry-content, main');
    if (!articleContent) return [];

    const text = articleContent.innerText;
    const sentenceRegex = /[^.!?]*[.!?]+/g;
    const matches = text.match(sentenceRegex) || [];
    
    return matches.map(s => s.trim()).filter(s => s.length > 0);
  }

  // ─── BUTTON CLICK HANDLER ─────────────────────────────
  button.addEventListener('click', async function(e) {
    e.preventDefault();

    if (isPlaying) {
      audio.pause();
      isPlaying = false;
      button.classList.remove('playing');
      button.querySelector('.lbc-tts-text').textContent = 'Play Aloud';
      return;
    }

    // If chunks already loaded, start playing
    if (audioChunks.length > 0) {
      playChunk(0);
      return;
    }

    // Otherwise, generate audio
    await generateAudio();
  });

  // ─── GENERATE AUDIO FROM RENDER BACKEND ───────────────
  async function generateAudio() {
    button.disabled = true;
    button.classList.add('loading');
    status.textContent = ' Generating audio...';
    status.className = 'lbc-tts-status loading';

    try {
      sentences = extractSentences();
      console.log(`📝 Extracted ${sentences.length} sentences`);

      // Call Render backend (via Cloudflare proxy)
      const response = await fetch(`${lbcTTS.apiUrl}/api/blog/read-aloud`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          blogPostId: lbcTTS.postId,
          blogUrl: lbcTTS.postUrl
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Unknown error');
      }

      // Store chunks
      audioChunks = data.audioChunks || [];
      console.log(`🎵 Received ${audioChunks.length} audio chunks`);

      // Calculate sentence timings
      sentenceTimings = calculateSentenceTimings(audioChunks);
      console.log(`⏱️  Calculated timings for ${sentenceTimings.length} sentences`);

      status.textContent = ` Ready to play (${audioChunks.length} chunks, ${data.totalChars} chars)`;
      status.className = 'lbc-tts-status generated';
      button.querySelector('.lbc-tts-text').textContent = 'Play Aloud';

      // Auto-play first chunk
      playChunk(0);

    } catch (error) {
      console.error('❌ Blog TTS Error:', error);
      status.textContent = ' Error: ' + error.message;
      status.className = 'lbc-tts-status error';
    } finally {
      button.disabled = false;
      button.classList.remove('loading');
    }
  }

  // ─── PLAY CHUNK SEQUENTIALLY ──────────────────────────
  function playChunk(chunkIndex) {
    if (chunkIndex >= audioChunks.length) {
      // All chunks played
      isPlaying = false;
      button.classList.remove('playing');
      button.querySelector('.lbc-tts-text').textContent = 'Play Aloud';
      
      // Clear highlighting
      const articleContent = document.querySelector('article, .post-content, .entry-content, main');
      if (articleContent) {
        articleContent.querySelectorAll('.lbc-tts-highlighted').forEach(el => {
          el.classList.remove('lbc-tts-highlighted');
        });
      }
      return;
    }

    currentChunkIndex = chunkIndex;

    // Decode base64 audio
    const byteChars = atob(audioChunks[chunkIndex].audioBase64);
    const byteNumbers = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteNumbers[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([byteNumbers], { type: 'audio/mpeg' });
    audio.src = URL.createObjectURL(blob);

    audio.play();
    isPlaying = true;
    button.classList.add('playing');
    button.querySelector('.lbc-tts-text').textContent = 'Pause';

    status.textContent = ` Playing chunk ${chunkIndex + 1}/${audioChunks.length}`;
    status.className = 'lbc-tts-status playing';
  }

  // ─── CALCULATE SENTENCE TIMINGS ───────────────────────
  function calculateSentenceTimings(audioChunks) {
    if (sentences.length === 0) return [];

    const charsPerSecond = 11; // Adjusted for 0.92 speaking rate
    const timings = [];
    let charsSoFar = 0;
    let currentChunkStartTime = 0;

    // Calculate total duration of each chunk
    const chunkDurations = audioChunks.map(chunk => 
      chunk.textLength / charsPerSecond
    );

    let chunkIndex = 0;
    let charsInCurrentChunk = 0;

    for (const sentence of sentences) {
      const sentenceChars = sentence.length;

      // Check if sentence moves to next chunk
      if (charsInCurrentChunk + sentenceChars > audioChunks[chunkIndex]?.textLength) {
        // Move to next chunk
        currentChunkStartTime += chunkDurations[chunkIndex];
        chunkIndex++;
        charsInCurrentChunk = 0;
      }

      const startTime = currentChunkStartTime + (charsInCurrentChunk / charsPerSecond);
      const endTime = startTime + (sentenceChars / charsPerSecond);

      timings.push({
        sentence: sentence,
        startTime: startTime,
        endTime: endTime,
        chunkIndex: chunkIndex
      });

      charsInCurrentChunk += sentenceChars + 1;
    }

    return timings;
  }

  // ─── HIGHLIGHT SENTENCE DURING PLAYBACK ───────────────
  function highlightSentence(currentTime) {
    const articleContent = document.querySelector('article, .post-content, .entry-content, main');
    if (!articleContent) return;

    articleContent.querySelectorAll('.lbc-tts-highlighted').forEach(el => {
      el.classList.remove('lbc-tts-highlighted');
    });

    for (const timing of sentenceTimings) {
      if (currentTime >= timing.startTime && currentTime < timing.endTime) {
        highlightTextInElement(articleContent, timing.sentence);
        break;
      }
    }
  }

  function highlightTextInElement(element, text) {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
      textNodes.push(node);
    }

    for (const textNode of textNodes) {
      const nodeText = textNode.textContent;
      const searchText = text.substring(0, Math.min(20, text.length));
      
      if (nodeText.includes(searchText)) {
        const span = document.createElement('span');
        span.className = 'lbc-tts-highlighted';
        span.textContent = text;
        
        if (textNode.parentNode) {
          textNode.parentNode.replaceChild(span, textNode);
        }
        break;
      }
    }
  }

  // ─── AUDIO EVENT LISTENERS ────────────────────────────
  audio.addEventListener('play', function() {
    isPlaying = true;
    button.classList.add('playing');
    button.querySelector('.lbc-tts-text').textContent = 'Pause';
  });

  audio.addEventListener('pause', function() {
    isPlaying = false;
    button.classList.remove('playing');
    button.querySelector('.lbc-tts-text').textContent = 'Play Aloud';
  });

  audio.addEventListener('ended', function() {
    // Current chunk finished, play next chunk
    playChunk(currentChunkIndex + 1);
  });

  audio.addEventListener('timeupdate', function() {
    if (sentenceTimings.length > 0) {
      highlightSentence(audio.currentTime);
    }
  });
});
