# Transcript Player

Upload a German audio file, get it transcribed with Whisper and translated to English, then play it back with word-level highlighting. Inspired by the Easy German podcast player.

Single-user, local, no auth.

---

## What it does

1. **Upload** an audio file via drag-and-drop
2. **Transcribe** with OpenRouter Whisper (`openai/whisper-large-v3`) — word-level timestamps
3. **Translate** with OpenRouter DeepSeek (`deepseek/deepseek-v4-pro`)
4. **Play** with an interactive transcript player — words highlight as audio plays, click segments to toggle English, click words to seek

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js + Express |
| Database | SQLite (`better-sqlite3`) — `data/db.sqlite` |
| Frontend | Plain HTML/CSS/JS (no framework, no build step) |
| File Uploads | `multer` → `data/audio/` |
| APIs | OpenRouter (Whisper + DeepSeek) |

---

## Quick Start

### 1. Prerequisites

- Node.js (see `.nvmrc` for version)
- An [OpenRouter](https://openrouter.ai/) API key

### 2. Setup

```bash
git clone <repo>
cd transcript-player
npm install
```

Create a `.env` file:

```bash
cp .env.example .env
# Edit .env and add your OPENROUTER_API_KEY
```

### 3. Run

```bash
nohup node server.js > /tmp/tp-server.log 2>&1 &
disown
```

> **Important:** Use `nohup` + `disown`. Starting with just `node server.js &` will kill the server when the shell exits.

Then open http://localhost:3000

---

## Project Structure

```
transcript-player/
├── server.js              # Express server, multer config, routes
├── db/
│   ├── schema.js          # SQLite schema + initDb()
│   └── queries.js         # All database access
├── routes/
│   └── episodes.js        # Route handlers + processEpisode pipeline
├── services/
│   ├── transcribe.js      # OpenRouter Whisper + segment derivation
│   └── translate.js       # OpenRouter DeepSeek batch translation
├── public/                # Static frontend assets
│   ├── index.html         # Upload page
│   ├── player.html        # Interactive player
│   ├── app.js             # Upload page logic
│   ├── player.js          # Player logic (word highlighting, etc.)
│   └── style.css
├── data/
│   ├── db.sqlite          # SQLite database (gitignored)
│   └── audio/             # Uploaded audio files (gitignored)
├── .env                   # OPENROUTER_API_KEY (gitignored)
└── .env.example
```

---

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/episodes` | Upload audio (multipart/form-data) → 201, async pipeline starts |
| `GET` | `/api/episodes` | List all episodes |
| `GET` | `/api/episodes/:id` | Full episode with segments and words |
| `GET` | `/api/episodes/:id/status` | Poll for processing stage |
| `PATCH` | `/api/episodes/:id` | Rename episode (`{ title }`) |
| `DELETE` | `/api/episodes/:id` | Delete episode + audio file |

---

## Processing Pipeline

| Stage | What happens |
|-------|-------------|
| `transcribing` | Whisper transcribes audio, returns word-level timestamps |
| `translating` | DeepSeek translates all segments in one batch prompt |
| `completed` / `error` | Final state |

The frontend polls `/api/episodes/:id/status` every 2 seconds to show progress.

---

## Key Architecture Notes

### Whisper Response Format

OpenRouter's Whisper endpoint returns **either** word-level timestamps **or** segments — never both in one call. This project requests `timestamp_granularities=word` (flat `words[]` array) and then derives segments in `transcribe.js` by:

- Sentence-ending punctuation (`.`, `!`, `?`) — excluding numbers like `300.000`
- Pauses > 2.0s between words
- Forced splits at 30+ words on `; : – —` boundaries
- Guarding against isolated short segments (< 3 words)
- Post-merge of very short segments into previous

### Translation

All segments are batched into a single DeepSeek prompt for efficiency. The response is parsed with a regex (`/^\d+[\.\)]\s?/`) to match each segment's translation.

---

## Frontend Features

- **Upload**: Drag & drop (default) or browse tab, progress bar, animated processing indicator with stage label + elapsed timer
- **Player**: Word-level highlighting synced to audio, click segment → toggle English translation, click word → seek, ▶ per segment, fixed bottom audio bar, double-click title to rename, delete episodes

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Your OpenRouter API key |
| `PORT` | Server port (default: 3000) |

---

## Known Gotchas

- **Start the server with `nohup` + `disown`** — otherwise it dies when the shell exits
- **Translation numbering**: If DeepSeek returns unexpected numbering format, the count mismatch sets `status: error`
- **No retry/queue**: Failed processing sets `status: error`; re-upload to retry
