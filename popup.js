/**
 * popup.js
 */

const STORAGE_KEY = 'taSettings';
const QUICK_CACHE_KEY = 'taQuickState';

function t(key) {
  return globalThis.TAi18n?.t(key) ?? key;
}

// Static fallback display names for built-in default models.
// Used when catalog cache is empty (no API key / fresh install).
// modelsService.js runs in the background context — not accessible here.
const MODEL_DISPLAY_NAMES = {
  'openai/gpt-5.5':                      'OpenAI: GPT-5.5',
  'openai/gpt-5.3-chat':                 'OpenAI: GPT-5.3 Chat',
  'google/gemini-3.1-pro-preview':        'Google: Gemini 3.1 Pro Preview',
  'google/gemini-3.1-flash-lite-preview': 'Google: Gemini 3.1 Flash Lite Preview',
  'qwen/qwen3-max-thinking':              'Qwen: Qwen3 Max Thinking',
  'deepseek/deepseek-v3.2':              'DeepSeek: DeepSeek V3.2',
};

function readQuickCache() {
  try {
    const raw = localStorage.getItem(QUICK_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeQuickCache(data) {
  try { localStorage.setItem(QUICK_CACHE_KEY, JSON.stringify(data)); } catch {}
}

const DEFAULT_SETTINGS = {
  widget_timer_ms: 5000,
  active_zone: 'right',
  widget_position: 'right',
  model_text: 'openai/gpt-5.5',
  model_vision: 'openai/gpt-5.5',
  model_favorites: [],
  multi_check_enabled: false,
  quiz_page_scan_enabled: false,
  quiz_auto_apply_enabled: false,
  save_logs: false,
  extension_enabled: true,
};

function showStatus(message, type = 'ok') {
  const el = document.getElementById('statusMsg');
  el.textContent = message;
  el.className = type;
  setTimeout(() => {
    el.className = '';
    el.textContent = '';
  }, 2500);
}

async function getSettings() {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEY] || {}) };
}

async function saveSetting(partial) {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  const next = { ...(data[STORAGE_KEY] || {}), ...partial };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  // Keep localStorage cache in sync so next popup open renders correct state instantly
  const cache = readQuickCache();
  if (cache) writeQuickCache({ ...cache, settings: { ...(cache.settings || {}), ...partial } });
}


async function getExtensionEnabled() {
  const data = await chrome.storage.local.get(['extension_enabled']);
  return data.extension_enabled !== false;
}

async function setExtensionEnabled(value) {
  await chrome.storage.local.set({ extension_enabled: Boolean(value) });
  // Keep localStorage cache in sync
  const cache = readQuickCache();
  if (cache) writeQuickCache({ ...cache, isEnabled: Boolean(value) });
}

function applyExtensionEnabledUi(isOn) {
  toggleExtensionEnabled.dataset.on = String(Boolean(isOn));
}

async function fetchBalanceText() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'GET_ROUTERAI_BALANCE' });
    if (!r?.ok) {
      return r?.noApiKey ? t('popup.balance_no_key') : t('popup.balance_unavailable');
    }
    return `${t('popup.balance_prefix')} ${r.amount}`;
  } catch {
    return t('popup.balance_unavailable');
  }
}

async function refreshBalance() {
  balanceText.textContent = await fetchBalanceText();
}

async function loadScreenshotQueueBadge() {
  try {
    const data = await chrome.storage.local.get(['taScreenshotQueue']);
    const count = Array.isArray(data.taScreenshotQueue) ? data.taScreenshotQueue.length : 0;
    const badge = document.getElementById('logsBadge');
    if (count > 0) {
      badge.textContent = `+${count} 📸`;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }
  } catch {
    // non-critical
  }
}

const timerRange = document.getElementById('timerRange');
const timerInput = document.getElementById('timerInput');
const answerZone = document.getElementById('answerZone');
const toggleMultiCheck = document.getElementById('toggleMultiCheck');
const toggleQuizPageScan = document.getElementById('toggleQuizPageScan');
const actionButtonsRow = document.querySelector('.btn-row');
const btnLogs = document.getElementById('btnLogs');
const modelTextInput = document.getElementById('modelTextInput');
const modelVisionInput = document.getElementById('modelVisionInput');
const modelTextList = document.getElementById('modelTextList');
const modelVisionList = document.getElementById('modelVisionList');
const balanceLine = document.getElementById('balanceLine');
const balanceText = document.getElementById('balanceText');
const toggleExtensionEnabled = document.getElementById('toggleExtensionEnabled');

let chatModelCatalog = [];
let imageModelCatalog = [];
let modelFavorites = [];

// Applies a cached state object to the DOM synchronously (no await).
// Called before the first paint to guarantee zero visible mutations.
function applyQuickCacheToDOM(cache) {
  const s = { ...DEFAULT_SETTINGS, ...(cache.settings || {}) };
  const isEnabled = cache.isEnabled !== false;
  modelFavorites = Array.isArray(s.model_favorites) ? s.model_favorites : [];
  if (cache.balance) balanceText.textContent = cache.balance;
  const sec = Math.min(30, Math.max(1, msToSec(Number(s.widget_timer_ms) || 5000)));
  timerRange.value = String(sec);
  timerInput.value = String(sec);
  // Store raw id in dataset; show fallback name immediately (catalog resolves later)
  const textId = s.model_text || DEFAULT_SETTINGS.model_text;
  const visionId = s.model_vision || DEFAULT_SETTINGS.model_vision;
  modelTextInput.dataset.modelId = textId;
  modelTextInput.value = MODEL_DISPLAY_NAMES[textId] || textId;
  modelVisionInput.dataset.modelId = visionId;
  modelVisionInput.value = MODEL_DISPLAY_NAMES[visionId] || visionId;
  applyExtensionEnabledUi(isEnabled);
  applyAnswerZoneUi(s.active_zone || s.widget_position || 'right');
  applyMultiCheckUi(Boolean(s.multi_check_enabled));
  applyQuizPageScanUi(Boolean(s.quiz_page_scan_enabled));
  applyLogsButtonUi(Boolean(s.save_logs));
}

// Synchronous pre-hydration — runs before the browser's first paint.
// Inline scripts at end of <body> block painting until they reach an await,
// so DOM mutations here are invisible to the user.
const __quickCache = readQuickCache();
if (__quickCache) {
  // Cache exists: apply immediately — first paint shows fully correct state
  applyQuickCacheToDOM(__quickCache);
} else {
  // First-ever open (no cache yet): hide until async boot loads data
  document.body.style.opacity = '0';
}

function orderedModels(models = []) {
  const favSet = new Set(modelFavorites || []);
  const seen = new Set();
  const uniq = models.filter((m) => {
    if (!m?.id || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  return uniq.sort((a, b) => {
    const af = favSet.has(a.id) ? 0 : 1;
    const bf = favSet.has(b.id) ? 0 : 1;
    if (af !== bf) return af - bf;
    return (a.id || '').localeCompare(b.id || '');
  });
}

async function loadModels() {
  try {
    const [chatResp, imageResp] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_CHAT_MODELS' }),
      chrome.runtime.sendMessage({ type: 'GET_IMAGE_MODELS' }),
    ]);
    if (chatResp?.ok && Array.isArray(chatResp.models)) chatModelCatalog = chatResp.models;
    if (imageResp?.ok && Array.isArray(imageResp.models)) imageModelCatalog = imageResp.models;
  } catch {
    // non-critical, user can still type model manually
  }
}

function findPopupModel(id, catalog) {
  if (!id) return null;
  // Search in the specified catalog first (type-filtered dropdown catalog)
  if (catalog) {
    const found = catalog.find((m) => m.id === id);
    if (found) return found;
  }
  // Fall back to all models — needed because saved vision models may be type=chat
  // (multimodal) which only appear in chatModelCatalog, not imageModelCatalog
  return [...chatModelCatalog, ...imageModelCatalog].find((m) => m.id === id) || null;
}

function setPopupInputDisplay(inputEl, modelId, catalog = null) {
  const model = findPopupModel(modelId, catalog);
  if (model) {
    inputEl.value = model.name || model.id;
    inputEl.dataset.modelId = model.id;
  } else {
    const fallback = MODEL_DISPLAY_NAMES[modelId];
    inputEl.value = fallback || modelId || '';
    inputEl.dataset.modelId = modelId || '';
  }
}

function resolvePopupInput(inputEl, catalog = null) {
  const typed = inputEl.value.trim();
  if (!typed) return;
  const currentId = inputEl.dataset.modelId || '';
  const currentModel = currentId ? findPopupModel(currentId, catalog) : null;
  const fallbackName = MODEL_DISPLAY_NAMES[currentId];
  if (typed === (currentModel?.name || currentModel?.id || fallbackName || currentId)) return;
  // Try id match first
  const byId = findPopupModel(typed, catalog);
  if (byId) { inputEl.value = byId.name || byId.id; inputEl.dataset.modelId = byId.id; return; }
  // Try name match
  const src = catalog || [...chatModelCatalog, ...imageModelCatalog];
  const byName = src.find((m) => (m.name || m.id).toLowerCase() === typed.toLowerCase());
  if (byName) { inputEl.value = byName.name || byName.id; inputEl.dataset.modelId = byName.id; }
}

function renderModelDropdown(listEl, inputEl, key, forceFilter = null, keepVisibility = false, catalog = null) {
  const filter = (forceFilter !== null ? forceFilter : (listEl.dataset.currentQuery ?? '')).trim().toLowerCase();
  listEl.dataset.currentQuery = filter;
  const baseCatalog = catalog !== null ? catalog : chatModelCatalog;
  const allModels = orderedModels([...(baseCatalog || [])]);
  const shown = allModels.filter((m) => !filter
    || (m.id || '').toLowerCase().includes(filter)
    || (m.name || '').toLowerCase().includes(filter)
    || (m.short_description || '').toLowerCase().includes(filter));
  const _wasVisible = listEl.style.display !== 'none';
  const _prevScrollTop = _wasVisible ? listEl.scrollTop : 0;
  listEl.innerHTML = '';

  for (const model of shown) {
    const row = document.createElement('div');
    row.className = 'model-item';

    const main = document.createElement('div');
    main.className = 'model-main';

    const nameEl = document.createElement('div');
    nameEl.className = 'model-name';
    nameEl.textContent = model.name || model.id;
    nameEl.title = model.id;

    const idEl = document.createElement('div');
    idEl.className = 'model-id';
    idEl.textContent = model.id;
    main.append(nameEl, idEl);

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'model-star';
    const favorite = modelFavorites.includes(model.id);
    star.textContent = favorite ? '★' : '☆';
    star.title = favorite ? t('popup.fav_remove') : t('popup.fav_add');
    star.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    star.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      modelFavorites = favorite
        ? modelFavorites.filter((m) => m !== model.id)
        : [...new Set([...modelFavorites, model.id])];
      await saveSetting({ model_favorites: modelFavorites });
      renderModelDropdown(modelTextList, modelTextInput, 'model_text', null, true, chatModelCatalog);
      renderModelDropdown(modelVisionList, modelVisionInput, 'model_vision', null, true, imageModelCatalog);
    });

    row.addEventListener('mousedown', async (e) => {
      e.preventDefault();
      setPopupInputDisplay(inputEl, model.id, catalog);
      await saveSetting({ [key]: model.id });
      listEl.style.display = 'none';
      showStatus(t('popup.model_saved'), 'ok');
    });

    row.append(main, star);
    listEl.appendChild(row);
  }

  if (keepVisibility) {
    if (!shown.length) listEl.style.display = 'none';
    else if (_wasVisible) listEl.style.display = 'block';
    // else: has items but was hidden — leave hidden
  } else {
    listEl.style.display = shown.length ? 'block' : 'none';
  }
  if (_wasVisible && listEl.style.display !== 'none') listEl.scrollTop = _prevScrollTop;
}

function wireModelInput(inputEl, listEl, key, getCatalog = () => chatModelCatalog) {
  inputEl.addEventListener('focus', () => renderModelDropdown(listEl, inputEl, key, '', false, getCatalog()));
  inputEl.addEventListener('click', () => renderModelDropdown(listEl, inputEl, key, '', false, getCatalog()));
  inputEl.addEventListener('input', () => renderModelDropdown(listEl, inputEl, key, inputEl.value, null, getCatalog()));
  inputEl.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      resolvePopupInput(inputEl, getCatalog());
      const modelId = inputEl.dataset.modelId || inputEl.value.trim();
      if (!modelId) return;
      await saveSetting({ [key]: modelId });
      listEl.style.display = 'none';
      showStatus(t('popup.model_saved'), 'ok');
    } else if (e.key === 'Escape') {
      listEl.style.display = 'none';
    }
  });
  inputEl.addEventListener('blur', () => setTimeout(() => {
    listEl.style.display = 'none';
    resolvePopupInput(inputEl, getCatalog());
  }, 120));
}

function msToSec(ms) {
  return Math.round(ms / 1000);
}

function secToMs(sec) {
  return sec * 1000;
}

async function loadTimer(settings) {
  const sec = Math.min(30, Math.max(1, msToSec(Number(settings.widget_timer_ms) || 5000)));
  timerRange.value = String(sec);
  timerInput.value = String(sec);
}

function applyLogsButtonUi(saveLogsEnabled) {
  btnLogs.hidden = !saveLogsEnabled;
  if (actionButtonsRow) {
    actionButtonsRow.classList.toggle('single', !saveLogsEnabled);
  }
}

function applyMultiCheckUi(isOn) {
  toggleMultiCheck.dataset.on = String(Boolean(isOn));
}

function applyQuizPageScanUi(isOn) {
  toggleQuizPageScan.dataset.on = String(Boolean(isOn));
}

function applyAnswerZoneUi(zone) {
  const normalized = ['left', 'right'].includes(zone) ? zone : 'right';
  answerZone.value = normalized;
}


let timerSaveTimeout = null;
const TIMER_DEFAULT_SEC = 5;

function applyTimerValue(sec) {
  timerRange.value = String(sec);
  timerInput.value = String(sec);
  clearTimeout(timerSaveTimeout);
  timerSaveTimeout = setTimeout(async () => {
    await saveSetting({ widget_timer_ms: secToMs(sec) });
    showStatus(t('popup.timer_saved').replace('{sec}', sec), 'ok');
  }, 400);
}

function validateTimerInput(raw) {
  const num = parseInt(raw, 10);
  if (Number.isFinite(num) && num >= 1 && num <= 30) return num;
  return TIMER_DEFAULT_SEC;
}

timerRange.addEventListener('input', () => {
  const sec = Number(timerRange.value);
  timerInput.value = String(sec);
  clearTimeout(timerSaveTimeout);
  timerSaveTimeout = setTimeout(async () => {
    await saveSetting({ widget_timer_ms: secToMs(sec) });
    showStatus(t('popup.timer_saved').replace('{sec}', sec), 'ok');
  }, 400);
});

timerInput.addEventListener('input', () => {
  const num = parseInt(timerInput.value, 10);
  if (Number.isFinite(num) && num >= 1 && num <= 30) {
    timerRange.value = String(num);
    clearTimeout(timerSaveTimeout);
    timerSaveTimeout = setTimeout(async () => {
      await saveSetting({ widget_timer_ms: secToMs(num) });
      showStatus(t('popup.timer_saved').replace('{sec}', num), 'ok');
    }, 400);
  }
});

timerInput.addEventListener('blur', () => {
  const sec = validateTimerInput(timerInput.value);
  applyTimerValue(sec);
});

timerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const sec = validateTimerInput(timerInput.value);
    applyTimerValue(sec);
    timerInput.blur();
  }
});

answerZone.addEventListener('change', async () => {
  const zone = answerZone.value;
  await saveSetting({ active_zone: zone, widget_position: zone });
  showStatus(t('popup.zone_saved').replace('{zone}', zone === 'left' ? t('popup.zone_left') : t('popup.zone_right')), 'ok');
});


toggleExtensionEnabled.addEventListener('click', async () => {
  const next = toggleExtensionEnabled.dataset.on !== 'true';
  applyExtensionEnabledUi(next);
  await setExtensionEnabled(next);
  try { await chrome.runtime.sendMessage({ type: 'EXTENSION_ENABLED_CHANGED', enabled: next }); } catch {}
  await refreshBalance();
  showStatus(next ? t('popup.ext_enabled_ok') : t('popup.ext_disabled_ok'), 'ok');
});

toggleMultiCheck.addEventListener('click', async () => {
  const next = toggleMultiCheck.dataset.on !== 'true';
  applyMultiCheckUi(next);
  await saveSetting({ multi_check_enabled: next });
  showStatus(next ? t('popup.multi_check_on') : t('popup.multi_check_off'), 'ok');
});

toggleQuizPageScan.addEventListener('click', async () => {
  const next = toggleQuizPageScan.dataset.on !== 'true';
  applyQuizPageScanUi(next);
  await saveSetting({ quiz_page_scan_enabled: next });
  showStatus(next ? t('popup.quiz_scan_on') : t('popup.quiz_scan_off'), 'ok');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.extension_enabled) {
    applyExtensionEnabledUi(changes.extension_enabled.newValue !== false);
  }
  if (!changes[STORAGE_KEY]) return;
  const next = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY].newValue || {}) };
  applyMultiCheckUi(Boolean(next.multi_check_enabled));
  applyQuizPageScanUi(Boolean(next.quiz_page_scan_enabled));
  applyLogsButtonUi(Boolean(next.save_logs));
  applyThemeToPopup(next);
});

function applyThemeToPopup(settings) {
  try {
    const eng = globalThis.TAThemeEngine;
    if (!eng) return;
    const MAPPING_ID = 'qm-popup-var-map';
    if (!settings?.theme_enabled) {
      eng.removeFromDocumentRoot();
      document.getElementById(MAPPING_ID)?.remove();
      return;
    }
    const presetName = settings.theme_global_preset || 'default';
    const customOverrides = settings.theme_global_custom || {};
    const vars = eng.generateVars(presetName, customOverrides);
    eng.applyToDocumentRoot(vars);
    let mapEl = document.getElementById(MAPPING_ID);
    if (!mapEl) {
      mapEl = document.createElement('style');
      mapEl.id = MAPPING_ID;
      document.head.appendChild(mapEl);
    }
    // Map --qm-* to popup's native variable namespace
    mapEl.textContent =
      `:root{` +
        `--bg:var(--qm-bg);` +
        `--surface:var(--qm-surface);` +
        `--surface-strong:var(--qm-surface-2);` +
        `--border:var(--qm-border);` +
        `--text:var(--qm-text);` +
        `--text-2:var(--qm-text-2);` +
        `--muted:var(--qm-muted);` +
        `--blue:var(--qm-accent);` +
        `--blue-soft:var(--qm-accent-light);` +
        `--glass-shadow:var(--qm-shadow);` +
        `--radius:var(--qm-radius);` +
      `}` +
      // Override hardcoded colors that bypass CSS variables
      `.balance-line{background:var(--blue-soft)!important;border-color:var(--border)!important;}` +
      `.timer-input-wrap{background:var(--blue-soft)!important;border-color:var(--border)!important;}` +
      `.timer-input{color:var(--blue)!important;}` +
      `.timer-unit{color:var(--blue)!important;}` +
      `.zone-select{background:var(--surface)!important;color:var(--text-2)!important;}` +
      `.model-input{background:var(--surface)!important;color:var(--text-2)!important;}` +
      `.model-list{background:var(--surface)!important;border-color:var(--border)!important;}` +
      `.model-item{border-bottom-color:var(--border)!important;}` +
      `.model-item:hover{background:var(--bg)!important;}` +
      `.model-name{color:var(--text)!important;}` +
      `.model-id{color:var(--muted)!important;}` +
      `.btn-secondary{background:var(--surface)!important;border-color:var(--border)!important;color:var(--text-2)!important;}` +
      `.widget-icon{filter:var(--qm-icon-filter,none)!important;}` +
      `body{background:radial-gradient(circle at 50% -90px,var(--blue-soft) 0%,transparent 62%),var(--bg)!important;}`;
  } catch {}
}

document.getElementById('btnSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

btnLogs.addEventListener('click', async () => {
  try {
    // Trigger unified QM log export in the active tab's content script.
    // This downloads exactly the same content as the Logs window "Download" button.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_QM_DOWNLOAD' });
      showStatus(r?.ok ? t('popup.logs_downloaded') : t('popup.logs_empty'), r?.ok ? 'ok' : 'err');
    } else {
      showStatus(t('popup.logs_empty'), 'err');
    }
  } catch {
    showStatus(t('popup.logs_error'), 'err');
  }
});

async function boot() {
  // Load language before rendering UI
  if (globalThis.TAi18n) {
    await globalThis.TAi18n.loadLanguage();
    globalThis.TAi18n.applyTranslations(document);
  }

  // Phase 1: Read from chrome.storage (fast, ~1-3 ms) — no network involved.
  // For normal opens the cache already applied the correct state synchronously,
  // so these writes are usually no-ops and cause zero visible change.
  const [settings, isEnabled] = await Promise.all([
    getSettings(),
    getExtensionEnabled(),
  ]);

  // Apply fresh settings from storage (overwrites cache if anything drifted)
  applyQuickCacheToDOM({
    settings,
    isEnabled,
    balance: __quickCache?.balance || balanceLine.textContent || '',
  });

  // Apply theme (non-blocking — after DOM is ready)
  applyThemeToPopup(settings);

  wireModelInput(modelTextInput, modelTextList, 'model_text', () => chatModelCatalog);
  wireModelInput(modelVisionInput, modelVisionList, 'model_vision', () => imageModelCatalog);

  // First-ever open had no cache — reveal now (only happens once after install)
  if (!__quickCache) {
    document.body.style.opacity = '1';
  }

  // Phase 2: Background work — never blocks or mutates visible UI unexpectedly.
  // Balance: fetch fresh value, update DOM only if it actually changed.
  const prevBalance = balanceText.textContent;
  fetchBalanceText().then((freshBalance) => {
    if (freshBalance !== prevBalance) balanceText.textContent = freshBalance;
    writeQuickCache({ settings, isEnabled, balance: freshBalance });
  }).catch(() => {
    writeQuickCache({ settings, isEnabled, balance: prevBalance });
  });

  loadScreenshotQueueBadge();
  loadModels().then(() => {
    // Resolve stored ids → names now that catalogs are loaded.
    // Pass null so findPopupModel searches all catalogs — critical for multimodal
    // chat models (e.g. gemini) saved as the vision model: they live in chatModelCatalog,
    // not imageModelCatalog, so a type-specific lookup would miss them.
    setPopupInputDisplay(modelTextInput, modelTextInput.dataset.modelId || modelTextInput.value, null);
    setPopupInputDisplay(modelVisionInput, modelVisionInput.dataset.modelId || modelVisionInput.value, null);
    renderModelDropdown(modelTextList, modelTextInput, 'model_text', null, false, chatModelCatalog);
    renderModelDropdown(modelVisionList, modelVisionInput, 'model_vision', null, false, imageModelCatalog);
    modelTextList.style.display = 'none';
    modelVisionList.style.display = 'none';
  });
}

boot().catch(console.error);
