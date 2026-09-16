const path = require('path');
const {
  createEpisode,
  setEpisodeStatus,
  updateEpisode,
  insertSegments,
  updateSegmentTranslations,
  replaceSegmentsAndWords,
  getEpisode,
  getEpisodeStatus,
  listEpisodes,
  deleteEpisode,
  insertChunks,
  getChunks,
  markChunkDone,
  markChunkFailed,
  setEpisodeProgress,
} = require('../db/queries');
const { transcribeChunk, resetTranscribeUsage, getTranscribeUsage } = require('../services/transcribe');
const { mergeChunks } = require('../services/merge');
const { translate } = require('../services/translate');
const { runPool } = require('../services/pool');
const {
  normalize,
  getDuration,
  detectSilences,
  pickCutPoints,
  cutChunks,
} = require('../services/audio');
const config = require('../config');

/**
 * Process an episode asynchronously: transcribe → insert segments/words → translate → update
 */
async function processEpisode(episodeId, audioPath) {
  try {
    // --- Phase 1: audio preparation (skip on retry — reuse stored cut points) ---
    let existingChunks = getChunks(episodeId);

    if (existingChunks.length === 0) {
      const originalDuration = await getDuration(audioPath);
      const normalizedPath = await normalize(audioPath, episodeId);
      const normalizedDuration = await getDuration(normalizedPath);
      updateEpisode(episodeId, { duration_seconds: normalizedDuration });

      if (Math.abs(originalDuration - normalizedDuration) > 0.5) {
        console.warn(
          `Duration mismatch for episode ${episodeId}: ` +
          `original ${originalDuration}s vs normalized ${normalizedDuration}s`
        );
      }

      const silences = await detectSilences(normalizedPath, normalizedDuration);
      const cutPoints = pickCutPoints(silences, normalizedDuration, config);
      const chunks = await cutChunks(normalizedPath, cutPoints, normalizedDuration, episodeId);
      insertChunks(episodeId, chunks);
      existingChunks = getChunks(episodeId);
      console.log(
        `Episode ${episodeId}: split into ${chunks.length} chunk(s), ` +
        `cut points [${cutPoints.map(c => c.toFixed(1)).join(', ')}]`
      );
    } else {
      console.log(
        `Episode ${episodeId}: reusing ${existingChunks.length} existing chunk(s)`
      );
    }

    // --- Phase 2: parallel chunk transcription ---
    updateEpisode(episodeId, { stage: 'transcribing' });

    const allChunks = getChunks(episodeId);
    const pending = allChunks.filter((c) => c.status !== 'done');
    const totalChunks = allChunks.length;
    updateEpisode(episodeId, { progress_total: totalChunks, progress_done: totalChunks - pending.length });
    const t0 = Date.now();

    if (pending.length > 0) {
      console.log(
        `Episode ${episodeId}: transcribing ${pending.length}/${totalChunks} chunk(s) ` +
        `(concurrency ${config.API_CONCURRENCY})`
      );

      let doneCount = totalChunks - pending.length;

      const results = await runPool(pending, config.API_CONCURRENCY, async (chunk) => {
        const chunkPath = path.join(
          __dirname, '..', 'data', 'audio', 'chunks', episodeId,
          `${String(chunk.idx).padStart(3, '0')}.wav`
        );
        const tChunk = Date.now();
        const result = await transcribeChunk(chunkPath, episodeId, chunk.idx);
        const elapsed = ((Date.now() - tChunk) / 1000).toFixed(1);
        const wc = result.segments.reduce((n, s) => n + s.words.length, 0);
        console.log(`  chunk ${chunk.idx} done: ${wc} words, ${elapsed}s`);
        markChunkDone(episodeId, chunk.idx, JSON.stringify(result));
        doneCount++;
        setEpisodeProgress(episodeId, doneCount, totalChunks);
        return result;
      });

      // Log transcription totals
      const tUsage = getTranscribeUsage();
      console.log(
        `[usage] transcription TOTALS episode=${episodeId} calls=${tUsage.calls} ` +
        `prompt=${tUsage.prompt_tokens} completion=${tUsage.completion_tokens} ` +
        `reasoning=${tUsage.reasoning_tokens} cost=$${tUsage.cost.toFixed(6)}`
      );
      resetTranscribeUsage();

      // Collect failures
      let failedCount = 0;
      for (let i = 0; i < results.length; i++) {
        if (!results[i].ok) {
          failedCount++;
          const chunk = pending[i];
          console.error(`  chunk ${chunk.idx} FAILED: ${results[i].error}`);
          markChunkFailed(episodeId, chunk.idx, results[i].error);
        }
      }

      if (failedCount > 0) {
        throw new Error(`${failedCount}/${pending.length} chunk(s) failed`);
      }
    }

    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `Episode ${episodeId}: all ${allChunks.length} chunk(s) done in ${wall}s wall time`
    );

    // --- Phase 3: merge, sanitize, and write segments/words ---
    const doneChunks = getChunks(episodeId);
    const result = mergeChunks(doneChunks);
    const totalWords = result.segments.reduce((n, s) => n + s.words.length, 0);
    console.log(
      `Episode ${episodeId}: merged ${result.segments.length} segments, ${totalWords} words total`
    );

    if (result.segments && result.segments.length > 0) {
      replaceSegmentsAndWords(episodeId, result.segments);
    } else {
      throw new Error('No segments returned from transcription');
    }

    // Delete chunk files after successful merge (best-effort)
    const fs = require('fs');
    const chunkDir = path.join(__dirname, '..', 'data', 'audio', 'chunks', episodeId);
    fs.rm(chunkDir, { recursive: true, force: true }, () => {});

    // 3. Translate
    updateEpisode(episodeId, { stage: 'translating' });
    const germanTexts = result.segments.map(s => s.text.trim());
    const translations = await translate(germanTexts, episodeId, (done, total) => {
      setEpisodeProgress(episodeId, done, total);
    });

    // 4. Store translations
    updateSegmentTranslations(episodeId, translations);

    // 5. Mark as ready
    setEpisodeStatus(episodeId, 'ready');
    updateEpisode(episodeId, { stage: null });
    setEpisodeProgress(episodeId, 0, 0);
    console.log(`Episode ${episodeId} processed successfully`);
  } catch (err) {
    console.error(`Error processing episode ${episodeId}:`, err.message);
    setEpisodeStatus(episodeId, 'error');
  }
}

/**
 * POST /api/episodes — upload audio + kick off processing
 */
function createEpisodeHandler(req, res) {
  const episodeId = req.episodeId;
  const audioFilename = req.file.filename;
  const title = req.body.title || path.basename(req.file.originalname, path.extname(req.file.originalname));

  try {
    createEpisode({ id: episodeId, title, audioFilename });
  } catch (err) {
    console.error('createEpisode failed:', err.message);
    return res.status(500).json({ error: 'Failed to create episode' });
  }

  res.status(201).json({ id: episodeId, status: 'processing' });

  // Fire and forget — don't await
  processEpisode(episodeId, req.file.path);
}

/**
 * GET /api/episodes — list all episodes
 */
function listEpisodesHandler(req, res) {
  const episodes = listEpisodes();
  res.json(episodes);
}

/**
 * GET /api/episodes/:id — full episode with segments and words
 */
function getEpisodeHandler(req, res) {
  const episode = getEpisode(req.params.id);
  if (!episode) {
    return res.status(404).json({ error: 'Episode not found' });
  }
  res.json(episode);
}

/**
 * GET /api/episodes/:id/status — lightweight status poll
 */
function getStatusHandler(req, res) {
  const episode = getEpisodeStatus(req.params.id);
  if (!episode) {
    return res.status(404).json({ error: 'Episode not found' });
  }
  res.json({
    id: episode.id,
    status: episode.status,
    stage: episode.stage,
    progress_done: episode.progress_done || 0,
    progress_total: episode.progress_total || 0,
    created_at: episode.created_at
  });
}

/**
 * DELETE /api/episodes/:id — delete episode, its segments, words, and audio file
 */
function deleteEpisodeHandler(req, res) {
  const audioFilename = deleteEpisode(req.params.id);
  if (!audioFilename) {
    return res.status(404).json({ error: 'Episode not found' });
  }

  // Remove audio file, normalized WAV, and chunk files from disk (best-effort)
  const fs = require('fs');
  const audioPath = path.join(__dirname, '..', 'data', 'audio', audioFilename);
  fs.unlink(audioPath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error('Failed to delete audio file:', err.message);
    }
  });
  fs.unlink(
    path.join(__dirname, '..', 'data', 'audio', 'normalized', `${req.params.id}.wav`),
    () => {}
  );
  fs.rm(
    path.join(__dirname, '..', 'data', 'audio', 'chunks', req.params.id),
    { recursive: true, force: true },
    () => {}
  );

  res.json({ deleted: true });
}

/**
 * PATCH /api/episodes/:id — rename an episode
 */
function renameEpisodeHandler(req, res) {
  const { title } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }

  try {
    updateEpisode(req.params.id, { title: title.trim() });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: 'Episode not found' });
  }
}

/**
 * POST /api/episodes/:id/retry — resume processing (uses stored cut points)
 */
function retryEpisodeHandler(req, res) {
  const episode = getEpisodeStatus(req.params.id);
  if (!episode) {
    return res.status(404).json({ error: 'Episode not found' });
  }

  const fs = require('fs');
  const audioPath = path.join(__dirname, '..', 'data', 'audio', episode.audio_filename);
  if (!fs.existsSync(audioPath)) {
    return res.status(400).json({ error: 'Audio file not found on disk' });
  }

  res.json({ ok: true, status: 'processing' });

  // Fire and forget — processEpisode skips normalize/split if chunks exist
  processEpisode(req.params.id, audioPath);
}

module.exports = {
  createEpisodeHandler,
  listEpisodesHandler,
  getEpisodeHandler,
  getStatusHandler,
  deleteEpisodeHandler,
  renameEpisodeHandler,
  retryEpisodeHandler,
};