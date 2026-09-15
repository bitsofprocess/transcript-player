require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const { randomUUID } = require('crypto');
const { initDb } = require('./db/schema');
const {
  createEpisodeHandler,
  listEpisodesHandler,
  getEpisodeHandler,
  getStatusHandler,
  deleteEpisodeHandler,
  renameEpisodeHandler,
} = require('./routes/episodes');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
initDb();

// Multer: generate episode ID before file save, use it as filename
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'data', 'audio'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${req.episodeId}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

// Parse JSON bodies for potential future use
app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio', express.static(path.join(__dirname, 'data', 'audio')));

// --- Routes ---

// POST /api/episodes — upload
app.post('/api/episodes', (req, res, next) => {
  req.episodeId = randomUUID();
  next();
}, upload.single('audio'), createEpisodeHandler);

// GET /api/episodes — list
app.get('/api/episodes', listEpisodesHandler);

// GET /api/episodes/:id — detail
app.get('/api/episodes/:id', getEpisodeHandler);

// GET /api/episodes/:id/status — polling
app.get('/api/episodes/:id/status', getStatusHandler);

// DELETE /api/episodes/:id — delete
app.delete('/api/episodes/:id', deleteEpisodeHandler);

// PATCH /api/episodes/:id — rename
app.patch('/api/episodes/:id', renameEpisodeHandler);

// Multer error handler
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large (max 500MB)' });
  }
  if (err.name === 'MulterError') {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});