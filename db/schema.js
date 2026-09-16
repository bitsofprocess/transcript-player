const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.sqlite');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDb() {
  const conn = getDb();

  conn.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      title TEXT,
      audio_filename TEXT NOT NULL,
      duration_seconds REAL,
      status TEXT NOT NULL DEFAULT 'processing',
      stage TEXT,
      progress_done INTEGER NOT NULL DEFAULT 0,
      progress_total INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL REFERENCES episodes(id),
      seq INTEGER NOT NULL,
      speaker TEXT,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      text_de TEXT NOT NULL,
      text_en TEXT
    );

    CREATE TABLE IF NOT EXISTS words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_id TEXT NOT NULL REFERENCES segments(id),
      seq INTEGER NOT NULL,
      word TEXT NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      episode_id TEXT NOT NULL REFERENCES episodes(id),
      idx INTEGER NOT NULL,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      error TEXT,
      PRIMARY KEY (episode_id, idx)
    );

    CREATE INDEX IF NOT EXISTS idx_segments_episode ON segments(episode_id, seq);
    CREATE INDEX IF NOT EXISTS idx_words_segment ON words(segment_id, seq);
  `);

  // Add stage column for existing databases
  try { conn.exec('ALTER TABLE episodes ADD COLUMN stage TEXT'); } catch (e) { /* already exists */ }
  // Add progress columns for existing databases
  try { conn.exec('ALTER TABLE episodes ADD COLUMN progress_done INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already exists */ }
  try { conn.exec('ALTER TABLE episodes ADD COLUMN progress_total INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already exists */ }

  console.log('Database initialized');
}

module.exports = { getDb, initDb };