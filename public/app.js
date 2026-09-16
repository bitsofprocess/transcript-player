// --- Upload page logic ---

const uploadForm = document.getElementById('upload-form');
const uploadStatus = document.getElementById('upload-status');
const episodesList = document.getElementById('episodes-list');
const fileInput = document.getElementById('audio-file');
const dropZone = document.getElementById('drop-zone');
const fileSelected = document.getElementById('file-selected');
const fileName = document.getElementById('file-name');
const fileClear = document.getElementById('file-clear');

let selectedFile = null;

// Load episodes on page load
loadEpisodes();

// --- Tab switching ---
document.querySelectorAll('.upload-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.upload-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.upload-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// --- Drag & Drop ---
['dragenter', 'dragover'].forEach(evt => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(evt => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
  });
});

dropZone.addEventListener('drop', (e) => {
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    setFile(files[0]);
  }
});

// Click drop zone to open file picker
dropZone.addEventListener('click', () => {
  fileInput.click();
});

// --- Browse tab: file input change ---
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    setFile(fileInput.files[0]);
  }
});

// --- File selection ---
function setFile(file) {
  selectedFile = file;
  fileName.textContent = file.name;
  fileSelected.classList.remove('hidden');
  dropZone.classList.add('has-file');
}

fileClear.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  fileSelected.classList.add('hidden');
  dropZone.classList.remove('has-file');
});

// --- Upload button ---
const uploadBtn = document.getElementById('upload-btn');
const progressBar = document.getElementById('progress-bar');
const progressFill = document.getElementById('progress-fill');
const statusText = document.getElementById('status-text');
const statusTimer = document.getElementById('status-timer');

uploadBtn.addEventListener('click', async (e) => {
  e.preventDefault();

  if (!selectedFile) {
    showStatus('error', 'Please select an audio file.');
    return;
  }

  const titleInput = document.getElementById('title');
  const formData = new FormData();
  formData.append('audio', selectedFile);
  if (titleInput.value.trim()) {
    formData.append('title', titleInput.value.trim());
  }

  uploadBtn.disabled = true;
  showProgress(0, 'Uploading...');

  try {
    const data = await uploadWithProgress('/api/episodes', formData);
    showProcessingStatus();
    pollStatus(data.id);
  } catch (err) {
    showStatus('error', 'Upload failed: ' + err.message);
    uploadBtn.disabled = false;
  }
});

function uploadWithProgress(url, formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        showProgress(pct, `Uploading... ${pct}%`);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(new Error('Invalid response'));
        }
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

    xhr.open('POST', url);
    xhr.send(formData);
  });
}

function showProgress(pct, message) {
  uploadStatus.className = 'status processing';
  if (pct !== null) {
    progressFill.style.width = pct + '%';
    progressBar.classList.remove('hidden');
    progressBar.classList.remove('indeterminate');
  } else {
    progressBar.classList.add('hidden');
  }
  statusText.textContent = message;
}

// --- Processing status with stage + timer ---
let pollStartTime = null;
let pollTimerInterval = null;

function showProcessingStatus() {
  pollStartTime = Date.now();
  statusTimer.textContent = '';
  progressBar.classList.remove('hidden');
  progressBar.classList.add('indeterminate');
  progressFill.style.width = '';
  uploadStatus.className = 'status processing';
  statusText.textContent = 'Processing...';
  updateElapsed();
  pollTimerInterval = setInterval(updateElapsed, 1000);
}

function updateElapsed() {
  if (!pollStartTime) return;
  const elapsed = Math.floor((Date.now() - pollStartTime) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  statusTimer.textContent = `Elapsed: ${m}:${s.toString().padStart(2, '0')}`;
}

function stageLabel(stage, done, total) {
  const map = {
    transcribing: 'Transcribing audio',
    translating: 'Translating segments',
    merging: 'Merging results',
  };
  const label = map[stage] || stage || 'Processing';
  if (done > 0 && total > 0) {
    return `${label}... ${done}/${total}`;
  }
  return `${label}...`;
}

async function pollStatus(episodeId) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/episodes/${episodeId}/status`);
      const data = await res.json();

      const done = data.progress_done || 0;
      const total = data.progress_total || 0;

      if (data.stage) {
        statusText.textContent = stageLabel(data.stage, done, total);
      }

      // Show determinate progress bar when we have progress numbers
      if (done > 0 && total > 0) {
        progressBar.classList.remove('indeterminate');
        progressFill.style.width = Math.round((done / total) * 100) + '%';
      }

      if (data.status === 'ready') {
        clearInterval(interval);
        clearInterval(pollTimerInterval);
        progressBar.classList.remove('indeterminate');
        progressFill.style.width = '100%';
        showStatus('ready', 'Ready! Redirecting...');
        statusTimer.textContent = '';
        setTimeout(() => {
          window.location.href = `/player.html?id=${episodeId}`;
        }, 800);
      } else if (data.status === 'error') {
        clearInterval(interval);
        clearInterval(pollTimerInterval);
        showErrorState(episodeId);
      }
    } catch (err) {
      // Server may be restarting — keep polling, show retrying
      console.error('Poll error:', err);
      statusTimer.textContent = statusTimer.textContent ? statusTimer.textContent + ' (retrying...)' : '';
    }
  }, 2000);
}

function showErrorState(episodeId) {
  uploadStatus.className = 'status error';
  progressBar.classList.add('hidden');
  statusText.textContent = 'Processing failed.';
  statusTimer.textContent = '';

  // Add retry button
  const retryBtn = document.createElement('button');
  retryBtn.className = 'btn-retry';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', async () => {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Retrying...';
    try {
      const res = await fetch(`/api/episodes/${episodeId}/retry`, { method: 'POST' });
      if (res.ok) {
        // Restart polling
        showProcessingStatus();
        pollStatus(episodeId);
      } else {
        retryBtn.disabled = false;
        retryBtn.textContent = 'Retry';
        statusText.textContent = 'Retry failed. Check server logs.';
      }
    } catch (err) {
      retryBtn.disabled = false;
      retryBtn.textContent = 'Retry';
      statusText.textContent = 'Retry failed: network error.';
    }
  });
  uploadStatus.appendChild(retryBtn);
  uploadBtn.disabled = false;
}

function showStatus(type, message) {
  uploadStatus.className = `status ${type}`;
  progressBar.classList.add('hidden');
  statusText.textContent = message;
  statusTimer.textContent = '';
}

async function loadEpisodes() {
  try {
    const res = await fetch('/api/episodes');
    const episodes = await res.json();

    if (!episodes.length) {
      episodesList.innerHTML = '<p class="muted">No episodes yet. Upload one above.</p>';
      return;
    }

    episodesList.innerHTML = episodes.map(ep => {
      const statusClass = ep.status;
      const duration = ep.duration_seconds ? formatDuration(ep.duration_seconds) : '';
      const link = ep.status === 'ready'
        ? `<a href="/player.html?id=${ep.id}">Open</a>`
        : '';

      return `
        <div class="episode-item">
          <div class="episode-info">
            <div class="episode-title" data-id="${ep.id}" title="Double-click to rename">${escapeHtml(ep.title || 'Untitled')}</div>
            <div class="episode-meta">
              <span class="episode-status ${statusClass}">${ep.status}</span>
              ${duration ? ' · ' + duration : ''}
            </div>
          </div>
          ${link}
          <button class="btn-delete" data-id="${ep.id}" title="Delete episode"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div>
      `;
    }).join('');

    episodesList.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        deleteEpisode(btn.dataset.id, btn);
      });
    });

    // Wire up double-click to rename
    episodesList.querySelectorAll('.episode-title').forEach(titleEl => {
      titleEl.addEventListener('dblclick', () => {
        beginRename(titleEl);
      });
    });
  } catch (err) {
    episodesList.innerHTML = '<p class="muted">Failed to load episodes.</p>';
  }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function deleteEpisode(id, btn) {
  if (!confirm('Delete this episode? This cannot be undone.')) return;

  btn.disabled = true;

  try {
    const res = await fetch(`/api/episodes/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    loadEpisodes();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
    btn.disabled = false;
  }
}

function beginRename(titleEl) {
  const episodeId = titleEl.dataset.id;
  const currentTitle = titleEl.textContent;

  // Replace title with an input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = currentTitle;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;

  const finish = async (save) => {
    if (finished) return;
    finished = true;

    if (!save || input.value.trim() === '' || input.value.trim() === currentTitle) {
      // Cancel — restore original title
      const newTitle = document.createElement('div');
      newTitle.className = 'episode-title';
      newTitle.dataset.id = episodeId;
      newTitle.title = 'Double-click to rename';
      newTitle.textContent = currentTitle;
      newTitle.addEventListener('dblclick', () => beginRename(newTitle));
      input.replaceWith(newTitle);
      return;
    }

    // Save rename
    try {
      const res = await fetch(`/api/episodes/${episodeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.value.trim() }),
      });
      if (!res.ok) throw new Error('Rename failed');
      loadEpisodes();
    } catch (err) {
      alert('Failed to rename: ' + err.message);
      loadEpisodes();
    }
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      finish(false);
    }
  });
}