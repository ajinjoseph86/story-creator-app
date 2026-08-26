const state = {
  characterModes: { character1: 'upload', character2: 'none', character3: 'none' },
  characterPhotos: { character1: null, character2: null, character3: null },
  duration: 20,
  currentVideoId: null,
};

const els = {
  characterPhotoInputs: {
    character1: document.getElementById('character1-photo'),
    character2: document.getElementById('character2-photo'),
    character3: document.getElementById('character3-photo'),
  },
  characterDescriptions: {
    character1: document.getElementById('character1-description'),
    character2: document.getElementById('character2-description'),
    character3: document.getElementById('character3-description'),
  },
  story: document.getElementById('story'),
  artStyle: document.getElementById('art-style'),
  aspectRatio: document.getElementById('aspect-ratio'),
  duration: document.getElementById('duration'),
  durationReadout: document.getElementById('duration-readout'),
  generateBtn: document.getElementById('generate-btn'),
  generateBtnText: document.getElementById('generate-btn-text'),
  costBadge: document.getElementById('cost-badge'),
  errorText: document.getElementById('error-text'),
  previewPlaceholder: document.getElementById('preview-placeholder'),
  previewVideo: document.getElementById('preview-video'),
  previewLoading: document.getElementById('preview-loading'),
  progressText: document.getElementById('progress-text'),
  progressBarFill: document.getElementById('progress-bar-fill'),
  downloadBtn: document.getElementById('download-btn'),
  gallery: document.getElementById('gallery'),
  budgetPill: document.getElementById('budget-pill'),
  budgetText: document.getElementById('budget-text'),
};

// kie.ai Seedance 2.5, 480p, image-reference (no video input) rate.
const COST_PER_SECOND_USD = 0.140;

function updateCostBadge() {
  const cost = state.duration * COST_PER_SECOND_USD;
  els.costBadge.textContent = `~$${cost.toFixed(2)}`;
}

// ---------- character mode tabs ----------

document.querySelectorAll('.mode-tabs').forEach((tabs) => {
  const target = tabs.dataset.target;
  tabs.querySelectorAll('.mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      tabs.querySelectorAll('.mode-tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll(`.mode-panel[data-panel="${target}"]`).forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.mode !== mode);
      });
      state.characterModes[target] = mode;
    });
  });
});

// ---------- photo slots ----------

function setupPhotoSlot(input, onChange) {
  const slot = input.closest('.photo-slot');
  input.addEventListener('change', () => {
    const file = input.files?.[0] || null;
    onChange(file);
    renderSlot(slot, file);
  });
}

function renderSlot(slot, file) {
  const existingThumb = slot.querySelector('img.thumb');
  const existingRemove = slot.querySelector('.remove-btn');
  if (existingThumb) existingThumb.remove();
  if (existingRemove) existingRemove.remove();

  if (!file) {
    slot.classList.remove('filled');
    return;
  }

  slot.classList.add('filled');
  const img = document.createElement('img');
  img.className = 'thumb';
  img.src = URL.createObjectURL(file);
  slot.appendChild(img);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn';
  removeBtn.innerHTML = '&times;';
  removeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const input = slot.querySelector('input[type="file"]');
    input.value = '';
    input.dispatchEvent(new Event('change'));
  });
  slot.appendChild(removeBtn);
}

setupPhotoSlot(els.characterPhotoInputs.character1, (file) => { state.characterPhotos.character1 = file; });
setupPhotoSlot(els.characterPhotoInputs.character2, (file) => { state.characterPhotos.character2 = file; });
setupPhotoSlot(els.characterPhotoInputs.character3, (file) => { state.characterPhotos.character3 = file; });

// ---------- duration ----------

els.duration.addEventListener('input', () => {
  state.duration = Number(els.duration.value);
  els.durationReadout.textContent = `${state.duration} seconds`;
  updateCostBadge();
});

// ---------- budget ----------

async function refreshBudget() {
  try {
    const res = await fetch('/api/budget');
    const data = await res.json();
    els.budgetText.textContent = `$${data.remainingUsd.toFixed(2)} left of today's budget`;
    els.budgetPill.classList.toggle('low', data.remainingUsd < 1);
  } catch (err) {
    // non-fatal
  }
}

// ---------- history / gallery ----------

async function refreshHistory() {
  try {
    const res = await fetch('/api/history');
    const history = await res.json();
    renderGallery(history);
  } catch (err) {
    // non-fatal
  }
}

function renderGallery(history) {
  els.gallery.innerHTML = '';
  const done = history.filter((entry) => entry.status === 'success');
  if (!done.length) {
    els.gallery.innerHTML = '<p class="gallery-empty">No stories generated yet.</p>';
    return;
  }
  done.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    item.innerHTML = `
      <video src="${entry.resultUrl}" muted loop playsinline></video>
      <a class="gallery-download" href="${entry.resultUrl}" download title="Download">&#8681;</a>
    `;
    const video = item.querySelector('video');
    item.addEventListener('mouseenter', () => video.play().catch(() => {}));
    item.addEventListener('mouseleave', () => { video.pause(); video.currentTime = 0; });
    item.addEventListener('click', (e) => {
      if (e.target.closest('.gallery-download')) return;
      showResult(entry);
    });
    els.gallery.appendChild(item);
  });
}

function showResult(entry) {
  els.previewPlaceholder.classList.add('hidden');
  els.previewVideo.src = entry.resultUrl;
  els.previewVideo.classList.remove('hidden');
  els.downloadBtn.classList.remove('hidden');
  els.downloadBtn.href = entry.resultUrl;
  state.currentVideoId = entry.id;
}

// ---------- generate ----------

function showError(message) {
  els.errorText.textContent = message;
}

function setLoading(isLoading) {
  els.generateBtn.disabled = isLoading;
  els.generateBtnText.textContent = isLoading ? 'Generating…' : 'Generate Story Video';
  els.previewLoading.classList.toggle('hidden', !isLoading);
  if (isLoading) {
    showError('');
    els.progressText.textContent = 'Starting…';
    els.progressBarFill.style.width = '0%';
  }
}

function updateProgress(entry) {
  if (entry.stage === 'writing prompt') {
    els.progressText.textContent = 'Writing the scene…';
    els.progressBarFill.style.width = '15%';
  } else if (entry.stage === 'generating video') {
    els.progressText.textContent = 'Generating your video…';
    els.progressBarFill.style.width = '55%';
  } else {
    els.progressText.textContent = 'Starting…';
    els.progressBarFill.style.width = '3%';
  }
}

els.generateBtn.addEventListener('click', async () => {
  showError('');

  const anyCharacterUsed = ['character1', 'character2', 'character3'].some((k) => state.characterModes[k] !== 'none');
  for (const key of ['character1', 'character2', 'character3']) {
    const mode = state.characterModes[key];
    if (mode === 'upload' && !state.characterPhotos[key]) {
      return showError(`Upload a photo for ${key.replace('character', 'Character ')}, or switch it to Describe/Not used.`);
    }
    if (mode === 'describe' && !els.characterDescriptions[key].value.trim()) {
      return showError(`Describe ${key.replace('character', 'Character ')}, or switch it to Upload/Not used.`);
    }
  }
  if (!els.story.value.trim() || els.story.value.trim().length < 20) {
    return showError('Write a bit more of your story first.');
  }

  const formData = new FormData();
  formData.append('story', els.story.value.trim());
  formData.append('duration', state.duration);
  formData.append('artStyle', els.artStyle.value.trim() || 'Realistic film');
  formData.append('aspectRatio', els.aspectRatio.value);
  for (const key of ['character1', 'character2', 'character3']) {
    const mode = state.characterModes[key];
    if (mode === 'none') continue;
    formData.append(`${key}Mode`, mode);
    if (mode === 'upload') {
      formData.append(`${key}Photo`, state.characterPhotos[key]);
    } else {
      formData.append(`${key}Description`, els.characterDescriptions[key].value.trim());
    }
  }

  setLoading(true);

  try {
    const res = await fetch('/api/generate', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Generation failed.');
    }

    const entry = await pollForResult(data.id);

    els.previewPlaceholder.classList.add('hidden');
    els.previewVideo.src = `${entry.resultUrl}?t=${Date.now()}`;
    els.previewVideo.classList.remove('hidden');
    els.previewVideo.play().catch(() => {});
    state.currentVideoId = entry.id;
    els.downloadBtn.classList.remove('hidden');
    els.downloadBtn.href = entry.resultUrl;

    await refreshBudget();
    await refreshHistory();
  } catch (err) {
    showError(err.message || 'Something went wrong.');
    if (els.previewVideo.classList.contains('hidden')) {
      els.previewPlaceholder.classList.remove('hidden');
    }
  } finally {
    setLoading(false);
  }
});

async function pollForResult(id, { intervalMs = 4000, timeoutMs = 40 * 60 * 1000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`/api/status/${id}`);
    const entry = await res.json();
    if (!res.ok) {
      throw new Error(entry.error || 'Could not check generation status.');
    }
    updateProgress(entry);
    if (entry.status === 'success') return entry;
    if (entry.status === 'fail') throw new Error(entry.error || 'Story generation failed.');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Generation timed out.');
}

// ---------- init ----------

updateCostBadge();
refreshBudget();
refreshHistory();
