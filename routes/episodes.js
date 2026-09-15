const path = require('path');
const {
  createEpisode,
  setEpisodeStatus,
  updateEpisode,
  insertSegments,
  updateSegmentTranslations,
  getEpisode,
  getEpisodeStatus,
  listEpisodes,
  deleteEpisode,
} = require('../db/queries');
const { transcribe } = require('../services/transcribe');
const { translate } = require('../services/translate');

/**
 * Process an episode asynchronously: transcribe → insert segments/words → translate → update
 */
async function processEpisode(episodeId, audioPath) {
  try {
    // 1. Transcribe
    updateEpisode(episodeId, { stage: 'transcribing' });
    const result = await transcribe(audioPath);
    console.log(`Episode ${episodeId}: transcribed ${result.segments.length} segments`);

    // Update duration if available
    if (result.duration) {
      updateEpisode(episodeId, { duration_seconds: result.duration });
    }

    // 2. Insert segments & words
    if (result.segments && result.segments.length > 0) {
      insertSegments(episodeId, result.segments);
    } else {
      throw new Error('No segments returned from transcription');
    }

    // 3. Translate
    updateEpisode(episodeId, { stage: 'translating' });
    const germanTexts = result.segments.map(s => s.text.trim());
    const translations = await translate(germanTexts);

    // 4. Store translations
    updateSegmentTranslations(episodeId, translations);

    // 5. Mark as ready
    setEpisodeStatus(episodeId, 'ready');
    updateEpisode(episodeId, { stage: null });
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
  res.json({ id: episode.id, status: episode.status, stage: episode.stage, created_at: episode.created_at });
}

/**
 * DELETE /api/episodes/:id — delete episode, its segments, words, and audio file
 */
function deleteEpisodeHandler(req, res) {
  const audioFilename = deleteEpisode(req.params.id);
  if (!audioFilename) {
    return res.status(404).json({ error: 'Episode not found' });
  }

  // Remove audio file from disk (best-effort)
  const fs = require('fs');
  const audioPath = path.join(__dirname, '..', 'data', 'audio', audioFilename);
  fs.unlink(audioPath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error('Failed to delete audio file:', err.message);
    }
  });

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

module.exports = {
  createEpisodeHandler,
  listEpisodesHandler,
  getEpisodeHandler,
  getStatusHandler,
  deleteEpisodeHandler,
  renameEpisodeHandler,
};