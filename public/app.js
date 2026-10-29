const MAX_CHARACTERS = 8;

const state = {
  characters: [], // { id, mode: 'upload' | 'describe', photo: File | null, el: HTMLElement }
  nextCharacterId: 1,
  environment: { mode: 'none', photo: null },
  duration: 20,
  currentVideoId: null,
};

const els = {
  charactersWrap: document.getElementById('characters'),
  addCharacterBtn: document.getElementById('add-character-btn'),
  environmentTabs: document.getElementById('environment-tabs'),
  environmentPhoto: document.getElementById('environment-photo'),
  environmentDescription: document.getElementById('environment-description'),
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

// Mirrors the server: non-realistic styles redraw each uploaded photo first (~$0.12 each).
const COST_PER_STYLE_IMAGE_USD = 0.12;
const NON_REALISTIC_STYLE = /anim|3d|\bcg\b|cartoon|stop.?motion|clay|paint|water.?colou?r|pixel|comic|illustrat|sketch|puppet|felt|lego|voxel|\bcel\b|ghibli|pixar|manga/i;

function updateCostBadge() {
  let cost = state.duration * COST_PER_SECOND_USD;
  if (NON_REALISTIC_STYLE.test(els.artStyle.value)) {
    const photos =
      state.characters.filter((c) => c.mode === 'upload' && c.photo).length +
      (state.environment.mode === 'upload' && state.environment.photo ? 1 : 0);
    cost += photos * COST_PER_STYLE_IMAGE_USD;
  }
  els.costBadge.textContent = `~${cost.toFixed(2)}`;
}

// ---------- mode tabs (shared by characters and environment) ----------

function bindModeTabs(tabsEl, onChange) {
  tabsEl.querySelectorAll('.mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      tabsEl.querySelectorAll('.mode-tab').forEach((b) => b.classList.toggle('active', b === btn));
      onChange(btn.dataset.mode);
    });
  });
}

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

// ---------- characters (add as many as you like, up to MAX_CHARACTERS) ----------

function renumberCharacters() {
  state.characters.forEach((ch, i) => {
    ch.el.querySelector('.character-title').textContent = 'Character ' + (i + 1);
  });
  els.addCharacterBtn.disabled = state.characters.length >= MAX_CHARACTERS;
  els.addCharacterBtn.textContent =
    state.characters.length >= MAX_CHARACTERS ? 'Maximum of ' + MAX_CHARACTERS + ' characters' : '+ Add character';
}

function addCharacter() {
  if (state.characters.length >= MAX_CHARACTERS) return;

  const ch = { id: state.nextCharacterId, mode: 'upload', photo: null, el: null };
  state.nextCharacterId += 1;

  const card = document.createElement('div');
  card.className = 'character-card';
  card.innerHTML =
    '<div class="row-between">' +
      '<h3 class="character-title"></h3>' +
      '<button type="button" class="remove-character-btn" title="Remove this character">&times;</button>' +
    '</div>' +
    '<div class="mode-tabs">' +
      '<button type="button" class="mode-tab active" data-mode="upload">Upload photo</button>' +
      '<button type="button" class="mode-tab" data-mode="describe">Describe</button>' +
    '</div>' +
    '<div class="mode-panel" data-mode="upload">' +
      '<div class="photo-slots single">' +
        '<label class="photo-slot">' +
          '<input type="file" accept="image/*" class="photo-input" />' +
          '<span class="plus">+</span>' +
          '<span class="slot-label">Photo</span>' +
        '</label>' +
      '</div>' +
    '</div>' +
    '<div class="mode-panel hidden" data-mode="describe">' +
      '<textarea class="text-input character-description" rows="2" placeholder="e.g. a tall man in his 30s, short dark hair, wearing a leather jacket"></textarea>' +
    '</div>';

  ch.el = card;
  bindModeTabs(card.querySelector('.mode-tabs'), (mode) => {
    ch.mode = mode;
    card.querySelectorAll('.mode-panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.dataset.mode !== mode);
    });
  });
  setupPhotoSlot(card.querySelector('.photo-input'), (file) => { ch.photo = file; });
  card.querySelector('.remove-character-btn').addEventListener('click', () => {
    state.characters = state.characters.filter((c) => c !== ch);
    card.remove();
    renumberCharacters();
  });

  state.characters.push(ch);
  els.charactersWrap.appendChild(card);
  renumberCharacters();
}

els.addCharacterBtn.addEventListener('click', addCharacter);

// ---------- environment ----------

bindModeTabs(els.environmentTabs, (mode) => {
  state.environment.mode = mode;
  document.querySelectorAll('[data-env-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.envPanel !== mode);
  });
});
setupPhotoSlot(els.environmentPhoto, (file) => { state.environment.photo = file; });

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

// ---------- prompt details ----------

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const promptDetailsEl = document.getElementById('prompt-details');

function renderInputs(inputs) {
  if (!inputs) return '';
  const card = (label, thumbUrl, description) =>
    '<div class="input-card">' +
      (thumbUrl
        ? '<img src="' + escapeHtml(thumbUrl) + '" alt="' + escapeHtml(label) + '" />'
        : '<div class="input-desc">' + escapeHtml(description || '') + '</div>') +
      '<span>' + escapeHtml(label) + (thumbUrl ? '' : ' (described)') + '</span>' +
    '</div>';
  const parts = (inputs.characters || []).map((c, i) => card(c.label || 'Character ' + (i + 1), c.thumbUrl, c.description));
  if (inputs.environment) parts.push(card('Environment', inputs.environment.thumbUrl, inputs.environment.description));
  if (!parts.length) return '';
  return '<h3>Used inputs</h3><div class="input-grid">' + parts.join('') + '</div>';
}

function formatTaken(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return 'made in ' + seconds + ' sec';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return 'made in ' + m + ' min' + (s ? ' ' + s + ' sec' : '');
}

function renderPromptDetails(info) {
  const meta = [
    info.artStyle,
    info.aspectRatio,
    info.duration ? info.duration + 's' : '',
    formatTaken(info.generationSeconds),
    info.createdAt ? new Date(info.createdAt).toLocaleString() : '',
  ].filter(Boolean).map(escapeHtml).join(' · ');
  const finalBlock = info.finalPrompt
    ? '<details><summary>Show the full written prompt</summary><pre>' + escapeHtml(info.finalPrompt) + '</pre>' +
      '<button type="button" class="copy-btn" id="copy-final-prompt">Copy written prompt</button></details>'
    : '';
  promptDetailsEl.innerHTML =
    '<h3>Prompt</h3><div class="prompt-meta">' + meta + '</div>' +
    '<p class="prompt-text">' + escapeHtml(info.promptText || '') + '</p>' + renderInputs(info.inputs) + finalBlock;
  promptDetailsEl.classList.remove('hidden');
  const copyBtn = document.getElementById('copy-final-prompt');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(info.finalPrompt).then(() => { copyBtn.textContent = 'Copied'; }).catch(() => {});
    });
  }
}

async function showPromptDetails(entry) {
  if (!promptDetailsEl) return;
  renderPromptDetails({
    promptText: entry.promptText || entry.story,
    finalPrompt: entry.finalPrompt || entry.finalPrompt,
    artStyle: entry.artStyle,
    aspectRatio: entry.aspectRatio,
    duration: entry.duration,
    createdAt: entry.createdAt,
    inputs: entry.inputs,
    generationSeconds: entry.generationSeconds,
  });
  if (entry.finalPrompt || entry.finalPrompt) return;
  try {
    const res = await fetch('/api/history/' + entry.id);
    if (!res.ok) return;
    const full = await res.json();
    if (state.currentVideoId === entry.id) renderPromptDetails(full);
  } catch (err) {
    // non-fatal: the short prompt is already shown
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
    item.title = [entry.promptText || '', formatTaken(entry.generationSeconds)].filter(Boolean).join('\n');
    item.innerHTML = `
      <video src="${entry.resultUrl}" muted loop playsinline></video>
      <div class="gallery-caption">${escapeHtml(entry.promptText || '')}</div>
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
  showPromptDetails(entry);
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
  if (entry.stage === 'styling characters') {
    els.progressText.textContent = 'Redrawing your characters in the chosen style…';
    els.progressBarFill.style.width = '8%';
  } else if (entry.stage === 'writing prompt') {
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

  for (const [i, ch] of state.characters.entries()) {
    const label = 'Character ' + (i + 1);
    if (ch.mode === 'upload' && !ch.photo) {
      return showError('Upload a photo for ' + label + ', switch it to Describe, or remove it.');
    }
    if (ch.mode === 'describe' && !ch.el.querySelector('.character-description').value.trim()) {
      return showError('Describe ' + label + ', switch it to Upload, or remove it.');
    }
  }
  if (state.environment.mode === 'upload' && !state.environment.photo) {
    return showError('Upload an environment photo, or switch the environment to Describe/Not used.');
  }
  if (state.environment.mode === 'describe' && !els.environmentDescription.value.trim()) {
    return showError('Describe the environment, or switch it to Upload/Not used.');
  }
  if (!els.story.value.trim() || els.story.value.trim().length < 20) {
    return showError('Write a bit more of your story first.');
  }

  const formData = new FormData();
  formData.append('story', els.story.value.trim());
  formData.append('duration', state.duration);
  formData.append('artStyle', els.artStyle.value.trim() || 'Realistic film');
  formData.append('aspectRatio', els.aspectRatio.value);
  state.characters.forEach((ch, i) => {
    const n = i + 1;
    formData.append('character' + n + 'Mode', ch.mode);
    if (ch.mode === 'upload') {
      formData.append('character' + n + 'Photo', ch.photo);
    } else {
      formData.append('character' + n + 'Description', ch.el.querySelector('.character-description').value.trim());
    }
  });
  if (state.environment.mode === 'upload') {
    formData.append('environmentMode', 'upload');
    formData.append('environmentPhoto', state.environment.photo);
  } else if (state.environment.mode === 'describe') {
    formData.append('environmentMode', 'describe');
    formData.append('environmentDescription', els.environmentDescription.value.trim());
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
    showPromptDetails(entry);
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
  let transientFailures = 0;
  while (Date.now() - started < timeoutMs) {
    // The host can briefly return an HTML error page (e.g. during a redeploy or restart).
    // Treat that as a transient blip and keep polling instead of failing the whole generation.
    let res;
    let entry;
    try {
      res = await fetch(`/api/status/${id}`);
      entry = await res.json();
      transientFailures = 0;
    } catch (err) {
      transientFailures += 1;
      if (transientFailures > 45) {
        throw new Error('Lost connection to the server while generating. Check the gallery in a minute — your video may still finish.');
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
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

['input', 'change', 'click'].forEach((evt) => document.addEventListener(evt, () => setTimeout(updateCostBadge, 0)));

addCharacter();

updateCostBadge();
refreshBudget();
refreshHistory();
