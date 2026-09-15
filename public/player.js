// --- Player page logic ---

const params = new URLSearchParams(window.location.search);
const episodeId = params.get('id');

const episodeTitle = document.getElementById('episode-title');
const episodeStatus = document.getElementById('episode-status');
const playerArea = document.getElementById('player-area');
const playerBar = document.getElementById('player-bar');
const playerError = document.getElementById('player-error');
const audioPlayer = document.getElementById('audio-player');
const transcript = document.getElementById('transcript');

// Flat list of all words in playback order, each with a reference to its span
let wordSequence = [];
let currentIndex = -1;
let currentWordSpan = null;

if (!episodeId) {
  showError('No episode ID provided. Go back and pick an episode.');
} else {
  loadEpisode(episodeId);
}

async function loadEpisode(id) {
  const detail = await fetch(`/api/episodes/${id}`);

  if (detail.status === 404) {
    showError('Episode not found.');
    return;
  }

  const ep = await detail.json();

  episodeTitle.textContent = ep.title || 'Untitled Episode';
  episodeStatus.textContent = ep.status;
  episodeStatus.className = `status-badge ${ep.status}`;

  if (ep.status !== 'ready') {
    // Still processing or errored — poll status
    if (ep.status === 'error') {
      showError('This episode failed to process. Please check the server logs.');
      return;
    }
    episodeStatus.className = 'status-badge processing';
    episodeStatus.textContent = 'processing...';
    pollStatus(id);
    return;
  }

  renderPlayer(ep);
}

function pollStatus(id) {
  const startTime = Date.now();

  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/episodes/${id}/status`);
      const data = await res.json();

      // Show stage if available
      if (data.stage) {
        const labels = { transcribing: 'Transcribing audio...', translating: 'Translating segments...' };
        episodeStatus.textContent = labels[data.stage] || data.stage;
      }

      // Show elapsed time
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      episodeTitle.textContent = `Processing... (${m}:${s.toString().padStart(2, '0')})`;

      if (data.status === 'ready') {
        clearInterval(interval);
        loadEpisode(id);
      } else if (data.status === 'error') {
        clearInterval(interval);
        showError('This episode failed to process. Please check the server logs.');
      }
    } catch (err) {
      console.error('Poll error:', err);
      episodeStatus.textContent = 'Retrying...';
    }
  }, 2000);
}

function renderPlayer(ep) {
  playerArea.classList.remove('hidden');
  playerBar.classList.remove('hidden');

  // Set audio source
  audioPlayer.src = `/audio/${ep.audio_filename}`;

  // Build transcript
  wordSequence = [];
  transcript.innerHTML = '';

  for (const seg of ep.segments) {
    const segEl = document.createElement('div');
    segEl.className = 'segment';

    // Play button
    const playBtn = document.createElement('button');
    playBtn.className = 'segment-play';
    playBtn.innerHTML = '&#9654;';
    playBtn.title = `Play from ${formatTime(seg.start_time)}`;
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      audioPlayer.currentTime = seg.start_time;
      audioPlayer.play();
    });
    segEl.appendChild(playBtn);

    // Segment body (text + translation)
    const body = document.createElement('div');
    body.className = 'segment-body';

    const textDe = document.createElement('div');
    textDe.className = 'text-de';

    for (const w of seg.words) {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = w.word;
      span.dataset.start = w.start;
      span.dataset.end = w.end;

      // Optional: click a word to seek
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        audioPlayer.currentTime = parseFloat(w.start);
      });

      textDe.appendChild(span);
      textDe.appendChild(document.createTextNode(' '));

      wordSequence.push({ start: w.start, end: w.end, span });
    }

    body.appendChild(textDe);

    // Translation div (toggled on segment body click)
    const transDiv = document.createElement('div');
    transDiv.className = 'translation';
    transDiv.textContent = seg.text_en || '(no translation)';
    body.appendChild(transDiv);

    body.addEventListener('click', () => {
      transDiv.classList.toggle('visible');
    });

    segEl.appendChild(body);
    transcript.appendChild(segEl);
  }

  // Sort words chronologically (defensive; DB already returns in order)
  wordSequence.sort((a, b) => a.start - b.start);

  // Wire up timeupdate
  audioPlayer.addEventListener('timeupdate', onTimeUpdate);

  // Also clear highlight on pause/seek idling
  audioPlayer.addEventListener('seeked', onTimeUpdate);
}

function onTimeUpdate() {
  const t = audioPlayer.currentTime;

  // Find the word containing time t
  // Advance currentIndex forward only (words are chronological)
  let found = -1;

  // If t is before the current highlight, scan from the start
  let start;
  if (currentIndex === -1 || t < wordSequence[currentIndex].start) {
    start = 0;
  } else {
    start = currentIndex;
  }

  for (let i = start; i < wordSequence.length; i++) {
    const w = wordSequence[i];
    if (t >= w.start && t < w.end) {
      found = i;
      break;
    }
    // If we've passed this word's end and haven't found it, continue
    if (w.start > t) {
      break; // words are chronological; no need to keep scanning
    }
  }

  if (found === -1) {
    // No word at this time (silence between words/segments)
    clearHighlight();
    currentIndex = -1;
    return;
  }

  if (found !== currentIndex) {
    clearHighlight();
    currentIndex = found;
    currentWordSpan = wordSequence[found].span;
    currentWordSpan.classList.add('highlighted');
    scrollWordIntoView(currentWordSpan);
  }
}

function clearHighlight() {
  if (currentWordSpan) {
    currentWordSpan.classList.remove('highlighted');
    currentWordSpan = null;
  }
}

function scrollWordIntoView(span) {
  const rect = span.getBoundingClientRect();
  // Only auto-scroll if the word is outside the viewport
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function showError(message) {
  playerError.textContent = message;
  playerError.classList.remove('hidden');
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}