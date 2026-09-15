const { getDb } = require('./schema');
const { v4: uuidv4 } = require('uuid');

function createEpisode({ id, title, audioFilename }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO episodes (id, title, audio_filename, status)
    VALUES (?, ?, ?, 'processing')
  `).run(id, title || null, audioFilename);
}

function setEpisodeStatus(id, status) {
  const db = getDb();
  db.prepare('UPDATE episodes SET status = ? WHERE id = ?').run(status, id);
}

function updateEpisode(id, fields) {
  const db = getDb();
  const allowed = ['title', 'status', 'duration_seconds', 'stage'];
  const sets = [];
  const vals = [];

  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      vals.push(fields[key]);
    }
  }

  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE episodes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function insertSegments(episodeId, segments) {
  const db = getDb();

  const insertSegment = db.prepare(`
    INSERT INTO segments (id, episode_id, seq, speaker, start_time, end_time, text_de)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertWord = db.prepare(`
    INSERT INTO words (segment_id, seq, word, start_time, end_time)
    VALUES (?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    segments.forEach((seg, segIdx) => {
      const segId = uuidv4();

      insertSegment.run(segId, episodeId, segIdx, seg.speaker || null, seg.start, seg.end, seg.text.trim());

      if (seg.words && Array.isArray(seg.words)) {
        seg.words.forEach((w, wordIdx) => {
          insertWord.run(segId, wordIdx, w.word, w.start, w.end);
        });
      }
    });
  });

  transaction();
}

function updateSegmentTranslations(episodeId, translations) {
  const db = getDb();
  const segments = db.prepare(
    'SELECT id, seq FROM segments WHERE episode_id = ? ORDER BY seq'
  ).all(episodeId);

  const update = db.prepare('UPDATE segments SET text_en = ? WHERE id = ?');

  const transaction = db.transaction(() => {
    for (let i = 0; i < segments.length; i++) {
      if (i < translations.length) {
        update.run(translations[i], segments[i].id);
      }
    }
  });

  transaction();
}

function getEpisode(id) {
  const db = getDb();
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
  if (!episode) return null;

  const segments = db.prepare(
    'SELECT * FROM segments WHERE episode_id = ? ORDER BY seq'
  ).all(id);

  for (const seg of segments) {
    seg.words = db.prepare(
      'SELECT word, start_time AS start, end_time AS end, seq FROM words WHERE segment_id = ? ORDER BY seq'
    ).all(seg.id);
  }

  episode.segments = segments;
  return episode;
}

function getEpisodeStatus(id) {
  const db = getDb();
  return db.prepare('SELECT id, status, stage, created_at FROM episodes WHERE id = ?').get(id) || null;
}

function listEpisodes() {
  const db = getDb();
  return db.prepare(
    'SELECT id, title, status, duration_seconds, audio_filename, created_at FROM episodes ORDER BY created_at DESC'
  ).all();
}

function deleteEpisode(id) {
  const db = getDb();
  // Fetch audio filename before deleting so we can remove the file
  const episode = db.prepare('SELECT audio_filename FROM episodes WHERE id = ?').get(id);
  if (!episode) return null;

  const transaction = db.transaction(() => {
    // Delete words for all segments of this episode
    db.prepare(`
      DELETE FROM words WHERE segment_id IN (
        SELECT id FROM segments WHERE episode_id = ?
      )
    `).run(id);
    // Delete segments
    db.prepare('DELETE FROM segments WHERE episode_id = ?').run(id);
    // Delete episode
    db.prepare('DELETE FROM episodes WHERE id = ?').run(id);
  });

  transaction();
  return episode.audio_filename;
}

module.exports = {
  createEpisode,
  setEpisodeStatus,
  updateEpisode,
  insertSegments,
  updateSegmentTranslations,
  getEpisode,
  getEpisodeStatus,
  listEpisodes,
  deleteEpisode,
};