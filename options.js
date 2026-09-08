/**
 * options.js
 *
 * Страница настроек QuizMind.
 * Поддерживает API-ключ, модели, переключатели и
 * интерактивную запись горячих клавиш с клавиатуры.
 */

const DEFAULT_SETTINGS = {
  model_text:               'openai/gpt-5.5',
  model_vision:             'openai/gpt-5.5',
  model_favorites:          [],
  favorite_models:          [],
  auto_send_screenshot:     false,
  save_logs:                false,
  log_location:             'MyExtensionLogs',
  log_location_mode:        'subfolder',
  log_filename:             'qm-scan',
  log_save_mode:            'downloads',
  custom_hotkey_screenshot: 'Ctrl+Shift+U',
  custom_hotkey_yandex_question: 'Ctrl+Shift+H',
  custom_hotkey_reset_windows:'Ctrl+Shift+R',
  custom_hotkey_toggle_extension:'Ctrl+Shift+L',
  custom_hotkey_logs:       'Alt+L',
  screenshot_temperature:    0,
  screenshot_max_tokens:     500,
  widget_timer_ms:          5000,
  active_zone:              'right',
  widget_position:          'right',
  test_mode:                false,
  multi_check_enabled:      false,
  quiz_page_scan_enabled:   false,
  quiz_auto_apply_enabled:  false,
  quiz_show_answer_widget:  false,
  multi_check_models: [
    'qwen/qwen3-max-thinking',
    'deepseek/deepseek-v3.2',
    'openai/gpt-5.5',
  ],
  screenshot_multi_check_models: [
    'google/gemini-3.1-flash-lite-preview',
    'openai/gpt-5.5',
  ],
};

/* ── DOM refs ─────────────────────────────────────────────────────── */

const apiKeyInput           = document.getElementById('apiKey');
const eyeBtn                = document.getElementById('eyeBtn');
const eyeBtnIcon            = document.getElementById('eyeBtnIcon');
const modelTextInput        = document.getElementById('modelText');
const modelVisionInput      = document.getElementById('modelVision');
const modelTextList         = document.getElementById('modelTextList');
const modelVisionList       = document.getElementById('modelVisionList');
const modelsStatusEl        = document.getElementById('modelsStatus');
const toggleAutoScreenshot  = document.getElementById('toggleAutoScreenshot');
const toggleTestMode        = document.getElementById('toggleTestMode');
const toggleLogs            = document.getElementById('toggleLogs');
const logsHotkeyItem        = document.getElementById('logsHotkeyItem');
const logLocationModeField  = document.getElementById('logLocationModeField');
const logLocationField      = document.getElementById('logLocationField');
const logFilenameField      = document.getElementById('logFilenameField');
const logSaveModeField      = document.getElementById('logSaveModeField');
const logLocationModeSelect = document.getElementById('logLocationMode');
const logLocationInput      = document.getElementById('logLocation');
const logFilenameInput      = document.getElementById('logFilename');
const logSaveModeSelect     = document.getElementById('logSaveMode');
const statusEl              = document.getElementById('status');
const conflictToast         = document.getElementById('conflictToast');
const conflictText          = document.getElementById('conflictText');
const screenshotTemperatureInput = document.getElementById('screenshotTemperature');
const screenshotMaxTokensInput = document.getElementById('screenshotMaxTokens');
const toggleScreenshotMultiCheck = document.getElementById('toggleScreenshotMultiCheck');
const toggleQuizShowWidget      = document.getElementById('toggleQuizShowWidget');
const toggleCoursePackEnabled   = document.getElementById('toggleCoursePackEnabled');
const toggleCoursePackChat      = document.getElementById('toggleCoursePackChat');
const toggleCoursePackYandex    = document.getElementById('toggleCoursePackYandex');
const coursePackUploadBtn       = document.getElementById('coursePackUploadBtn');
const coursePackClearBtn        = document.getElementById('coursePackClearBtn');
const coursePackFileInput       = document.getElementById('coursePackFileInput');
const coursePackSummary         = document.getElementById('coursePackSummary');
const coursePackMessage         = document.getElementById('coursePackMessage');
const coursePackTitle           = document.getElementById('coursePackTitle');
const coursePackId              = document.getElementById('coursePackId');
const coursePackLanguage        = document.getElementById('coursePackLanguage');
const coursePackCreatedAt       = document.getElementById('coursePackCreatedAt');
const coursePackLectureCount    = document.getElementById('coursePackLectureCount');
const coursePackChunkCount      = document.getElementById('coursePackChunkCount');

/* ── Helpers ─────────────────────────────────────────────────────── */

/** Strip characters that are invalid in file names across OS and Chrome. */
function sanitizeLogFilename(raw) {
  return String(raw || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
}

/* ── Status ──────────────────────────────────────────────────────── */

let statusTimer = null;

function setStatus(message, type = 'info', autoClearMs = 0) {
  statusEl.textContent = message;
  statusEl.className   = type === 'ok' ? 'status-ok' : type === 'error' ? 'status-err' : 'status-info';
  if (statusTimer) clearTimeout(statusTimer);
  if (autoClearMs > 0) {
    statusTimer = setTimeout(() => {
      if (statusEl.textContent === message) statusEl.textContent = '';
    }, autoClearMs);
  }
}

/* ── Toggle ──────────────────────────────────────────────────────── */

function setToggle(btn, value) { btn.dataset.on = String(Boolean(value)); }
function getToggle(btn) { return btn.dataset.on === 'true'; }

/* ── Key combo rendering ─────────────────────────────────────────── */

/**
 * Разбивает строку "Ctrl+Shift+Y" в массив токенов.
 */
function parseCombo(str) {
  if (!str) return [];
  return str.split('+').map((s) => s.trim()).filter(Boolean);
}

/**
 * Рендерит key combo в HTML с бейджами.
 * @param {string} hotkeyStr  "Ctrl+Shift+Y"
 * @returns {string}          HTML
 */
function renderKeyCombo(hotkeyStr) {
  const parts = parseCombo(hotkeyStr);
  if (!parts.length) return '<span style="color:#94a3b8;font-size:11px">—</span>';

  return parts.map((part, i) => {
    const plus = i < parts.length - 1
      ? '<span class="key-plus">+</span>'
      : '';
    return `<span class="key-badge">${escHtml(part)}</span>${plus}`;
  }).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Обновляет отображение комбо в элементе хоткея.
 */
function applyComboToItem(itemEl, hotkeyStr) {
  const display = itemEl.querySelector('[data-combo-display]');
  if (display) display.innerHTML = renderKeyCombo(hotkeyStr);
  itemEl.dataset.currentValue = hotkeyStr || '';
}

/* ── Hotkey recording ────────────────────────────────────────────── */

const HOTKEY_ITEMS_META = [
  { key: 'custom_hotkey_screenshot',       labelKey: 'hotkeys.screenshot',    default: 'Ctrl+Shift+U' },
  { key: 'custom_hotkey_yandex_question',      labelKey: 'hotkeys.yandex_question',   default: 'Ctrl+Shift+H' },
  { key: 'custom_hotkey_reset_windows',    labelKey: 'hotkeys.reset_windows', default: 'Ctrl+Shift+R' },
  { key: 'custom_hotkey_toggle_extension', labelKey: 'hotkeys.toggle_ext',    default: 'Ctrl+Shift+L' },
  { key: 'custom_hotkey_logs',             labelKey: 'hotkeys.logs',          default: 'Alt+L' },
];

function t(key) {
  return globalThis.TAi18n?.t(key) ?? key;
}

/** Текущая сессия записи: { itemEl, settingsKey } | null */
let activeRecorder = null;

/**
 * Переводит KeyboardEvent в строку "Ctrl+Shift+Y".
 * Возвращает null если ввод недопустим, 'CANCEL' для Escape.
 */
function buildComboString(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  if (e.key === 'Escape') return 'CANCEL';
  if (e.key === 'Tab')   return null; // зарезервирован браузером

  // Требуем Ctrl, Alt или Meta
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;

  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey)             parts.push('Shift');
  if (e.altKey)               parts.push('Alt');

  const KEY_MAP = {
    ' ':           'Space',
    'ArrowUp':     '↑',
    'ArrowDown':   '↓',
    'ArrowLeft':   '←',
    'ArrowRight':  '→',
    'Enter':       'Enter',
    'Backspace':   'Backspace',
    'Delete':      'Delete',
    'Home':        'Home',
    'End':         'End',
    'PageUp':      'PgUp',
    'PageDown':    'PgDn',
    'Insert':      'Insert',
    'F1':  'F1',  'F2':  'F2',  'F3':  'F3',  'F4':  'F4',
    'F5':  'F5',  'F6':  'F6',  'F7':  'F7',  'F8':  'F8',
    'F9':  'F9',  'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
  };

  // On macOS, Alt/Option changes e.key to a composed char (e.g. Option+L → '¬').
  // Use e.code (physical key) when Alt is held, so the stored string stays portable.
  let rawKey = e.key;
  if (e.altKey && e.code) {
    if (e.code.startsWith('Key'))   rawKey = e.code.slice(3);      // 'KeyL'   → 'L'
    else if (e.code.startsWith('Digit')) rawKey = e.code.slice(5); // 'Digit1' → '1'
  }
  let key = KEY_MAP[rawKey] || (rawKey.length === 1 ? rawKey.toUpperCase() : rawKey);
  parts.push(key);

  return parts.join('+');
}

/**
 * Проверяет, занято ли данное сочетание другим хоткеем.
 * @returns {string|null}  метка конфликтующего хоткея или null
 */
function findConflict(combo, excludeKey) {
  const items = document.querySelectorAll('[data-settings-key]');
  for (const item of items) {
    if (item.dataset.settingsKey === excludeKey) continue;
    if ((item.dataset.currentValue || '') === combo) {
      const meta = HOTKEY_ITEMS_META.find((m) => m.key === item.dataset.settingsKey);
      return meta ? t(meta.labelKey) : item.dataset.settingsKey;
    }
  }
  return null;
}

function showConflict(label) {
  conflictText.textContent = t('hotkeys.conflict').replace('{label}', label);
  conflictToast.classList.add('visible');
  setTimeout(() => conflictToast.classList.remove('visible'), 3000);
}

/**
 * Начать запись для конкретного itemEl.
 */
function startRecording(itemEl) {
  if (activeRecorder) stopRecording(false);

  activeRecorder = {
    itemEl,
    settingsKey: itemEl.dataset.settingsKey,
  };

  itemEl.classList.add('recording');
  itemEl.querySelector('.hotkey-right').style.display   = 'none';
  itemEl.querySelector('.recording-zone').style.display = 'flex';

  document.addEventListener('keydown', onRecordKeydown, true);
}

/**
 * Завершить запись.
 * @param {string|null} comboToApply  null = только отмена
 */
function stopRecording(comboToApply) {
  if (!activeRecorder) return;

  document.removeEventListener('keydown', onRecordKeydown, true);

  const { itemEl, settingsKey } = activeRecorder;
  activeRecorder = null;

  itemEl.classList.remove('recording');
  itemEl.querySelector('.hotkey-right').style.display   = '';
  itemEl.querySelector('.recording-zone').style.display = 'none';

  if (comboToApply) {
    applyComboToItem(itemEl, comboToApply);
    // Автосохранение хоткея
    autoSaveHotkey(settingsKey, comboToApply);
  }
}

function onRecordKeydown(e) {
  e.preventDefault();
  e.stopPropagation();

  const combo = buildComboString(e);
  if (!combo) return; // только модификаторы — ждём дальше
  if (combo === 'CANCEL') { stopRecording(null); return; }

  const conflict = findConflict(combo, activeRecorder?.settingsKey);
  if (conflict) { showConflict(conflict); return; }

  stopRecording(combo);
}

async function autoSaveHotkey(key, value) {
  try {
    await savePartialSettings({ [key]: value });
    setStatus(t('common.saved'), 'ok', 1800);
  } catch (e) {
    setStatus(t('common.error').replace('{msg}', e.message), 'error');
  }
}

/**
 * Инициализирует один элемент хоткея: вешает обработчики.
 */
function initHotkeyItem(itemEl) {
  const editBtn   = itemEl.querySelector('.hotkey-edit-btn');
  const resetBtn  = itemEl.querySelector('.hotkey-reset-btn');
  const cancelBtn = itemEl.querySelector('.recording-cancel-btn');
  const defValue  = itemEl.dataset.default;

  editBtn.addEventListener('click', () => startRecording(itemEl));
  cancelBtn.addEventListener('click', () => stopRecording(null));

  resetBtn.addEventListener('click', async () => {
    if (!defValue) return;
    const conflict = findConflict(defValue, itemEl.dataset.settingsKey);
    if (conflict) { showConflict(conflict); return; }
    applyComboToItem(itemEl, defValue);
    await autoSaveHotkey(itemEl.dataset.settingsKey, defValue);
  });
}

/* ── Storage helpers ─────────────────────────────────────────────── */

const STORAGE_KEY = 'taSettings';
let hotkeyItemsInited = false;
let suppressAutoSave = false;

function mergeSettings(partial = {}) {
  return { ...DEFAULT_SETTINGS, ...(partial || {}) };
}

function readStorageSettings(raw) {
  return mergeSettings(raw?.[STORAGE_KEY] || {});
}

function applySettingsToUi(s) {
  suppressAutoSave = true;
  // setModelInputDisplay sets both value (display name / raw id) and dataset.modelId
  setModelInputDisplay(modelTextInput, s.model_text || '');
  setModelInputDisplay(modelVisionInput, s.model_vision || '');
  logLocationInput.value = s.log_location || DEFAULT_SETTINGS.log_location;
  if (logLocationModeSelect) logLocationModeSelect.value = s.log_location_mode || DEFAULT_SETTINGS.log_location_mode;
  if (logFilenameInput) logFilenameInput.value = s.log_filename || DEFAULT_SETTINGS.log_filename;
  if (logSaveModeSelect) logSaveModeSelect.value = s.log_save_mode || DEFAULT_SETTINGS.log_save_mode;
  if (screenshotTemperatureInput) screenshotTemperatureInput.value = String(Number.isFinite(Number(s.screenshot_temperature)) ? Number(s.screenshot_temperature) : DEFAULT_SETTINGS.screenshot_temperature);
  if (screenshotMaxTokensInput) screenshotMaxTokensInput.value = String(Number.isFinite(Number(s.screenshot_max_tokens)) ? Number(s.screenshot_max_tokens) : DEFAULT_SETTINGS.screenshot_max_tokens);

  setToggle(toggleAutoScreenshot, s.auto_send_screenshot ?? DEFAULT_SETTINGS.auto_send_screenshot);
  if (toggleTestMode) setToggle(toggleTestMode, s.test_mode ?? DEFAULT_SETTINGS.test_mode);
  setToggle(toggleLogs, s.save_logs ?? DEFAULT_SETTINGS.save_logs);
  if (toggleQuizShowWidget) setToggle(toggleQuizShowWidget, s.quiz_show_answer_widget ?? DEFAULT_SETTINGS.quiz_show_answer_widget);
  const logsEnabled = getToggle(toggleLogs);
  const logsVisible = logsEnabled ? 'block' : 'none';
  if (logLocationModeField) logLocationModeField.style.display = logsVisible;
  const isSubfolder = !logLocationModeSelect || logLocationModeSelect.value === 'subfolder';
  logLocationField.style.display = logsEnabled && isSubfolder ? 'block' : 'none';
  if (logFilenameField) logFilenameField.style.display = logsVisible;
  if (logSaveModeField) logSaveModeField.style.display = logsVisible;
  if (logsHotkeyItem) logsHotkeyItem.style.display = logsEnabled ? '' : 'none';

  currentMultiModels = Array.isArray(s.multi_check_models) ? [...s.multi_check_models] : [...DEFAULT_SETTINGS.multi_check_models];
  currentScreenshotMultiModels = Array.isArray(s.screenshot_multi_check_models) ? [...s.screenshot_multi_check_models] : [...DEFAULT_SETTINGS.screenshot_multi_check_models];
  renderMultiModels();
  renderScreenshotMultiModels();

  for (const meta of HOTKEY_ITEMS_META) {
    const itemEl = document.querySelector(`[data-settings-key="${meta.key}"]`);
    if (!itemEl) continue;
    const value = s[meta.key] || meta.default;
    applyComboToItem(itemEl, value);
    if (!hotkeyItemsInited) initHotkeyItem(itemEl);
  }

  modelFavorites = Array.isArray(s.model_favorites)
    ? s.model_favorites
    : (Array.isArray(s.favorite_models) ? s.favorite_models : []);
  if (chatModelsCatalog.length || imageModelsCatalog.length) {
    renderModelList({ inputEl: modelTextInput,  listEl: modelTextList,  kind: 'text',   query: modelTextList.dataset.currentQuery ?? '', keepVisibility: true });
    renderModelList({ inputEl: modelVisionInput, listEl: modelVisionList, kind: 'vision', query: modelVisionList.dataset.currentQuery ?? '', keepVisibility: true });
  }

  hotkeyItemsInited = true;
  suppressAutoSave = false;
}

async function savePartialSettings(partial, successMsg = '') {
  const nextPartial = { ...(partial || {}) };
  if (Array.isArray(nextPartial.model_favorites) && !Array.isArray(nextPartial.favorite_models)) {
    nextPartial.favorite_models = [...nextPartial.model_favorites];
  }
  if (Array.isArray(nextPartial.favorite_models) && !Array.isArray(nextPartial.model_favorites)) {
    nextPartial.model_favorites = [...nextPartial.favorite_models];
  }
  const existing = await chrome.storage.local.get([STORAGE_KEY]);
  const next = mergeSettings({ ...(existing[STORAGE_KEY] || {}), ...nextPartial });
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  if (successMsg) setStatus(successMsg, 'ok', 1200);
}

function queueAutoSave() {
  if (suppressAutoSave) return;
  const payload = readFormValues();
  payload.widget_current_model = payload.model_text;
  savePartialSettings(payload, t('common.saved')).catch((e) => {
    setStatus(t('common.error').replace('{msg}', e.message), 'error');
  });
}

/* ── Course Pack ─────────────────────────────────────────────────── */

let coursePackSectionInitialized = false;

function logCoursePackAction(message, meta = {}) {
  try {
    const result = chrome.runtime?.sendMessage?.({ type:'LOG_ACTION', payload:{ message, meta } });
    result?.catch?.(() => {});
  } catch {}
}

function setCoursePackMessage(message = '', type = 'info') {
  if (!coursePackMessage) return;
  coursePackMessage.textContent = message;
  coursePackMessage.dataset.type = type;
}

function getCoursePackErrorMessage(error) {
  const code = String(error?.code || 'storage');
  const key = `course_pack.error_${code}`;
  const translated = t(key);
  const fallback = error?.message || t('course_pack.error_storage');
  return (translated === key ? fallback : translated).replace('{index}', String(error?.message || ''));
}

function renderCoursePackState(state) {
  const pack = state?.pack || null;
  const hasPack = Boolean(pack);
  setToggle(toggleCoursePackEnabled, hasPack && state.enabled);
  setToggle(toggleCoursePackChat, state?.useChat !== false);
  setToggle(toggleCoursePackYandex, state?.useYandex !== false);
  if (toggleCoursePackEnabled) toggleCoursePackEnabled.disabled = !hasPack;
  if (toggleCoursePackChat) toggleCoursePackChat.disabled = !hasPack;
  if (toggleCoursePackYandex) toggleCoursePackYandex.disabled = !hasPack;
  if (coursePackClearBtn) coursePackClearBtn.disabled = !hasPack;
  if (coursePackSummary) coursePackSummary.hidden = !hasPack;
  if (!hasPack) {
    setCoursePackMessage(t('course_pack.empty'), 'info');
    return;
  }
  if (coursePackTitle) coursePackTitle.textContent = pack.title || '—';
  if (coursePackId) coursePackId.textContent = pack.courseId || '—';
  if (coursePackLanguage) coursePackLanguage.textContent = pack.language || '—';
  if (coursePackCreatedAt) coursePackCreatedAt.textContent = pack.createdAt || '—';
  if (coursePackLectureCount) coursePackLectureCount.textContent = String(pack.lectures?.length || 0);
  if (coursePackChunkCount) coursePackChunkCount.textContent = String(pack.chunks?.length || 0);
}

async function refreshCoursePackState({ preserveMessage = false } = {}) {
  const api = globalThis.TACoursePack;
  if (!api) return;
  const state = await api.getCoursePackState({ force:true });
  const previousMessage = preserveMessage ? coursePackMessage?.textContent : '';
  const previousType = preserveMessage ? coursePackMessage?.dataset.type : '';
  renderCoursePackState(state);
  if (preserveMessage && previousMessage) setCoursePackMessage(previousMessage, previousType || 'info');
}

async function saveCoursePackToggle(key, value) {
  const api = globalThis.TACoursePack;
  if (!api) return;
  await api.setCoursePackPreferences({ [key]:value });
  await refreshCoursePackState({ preserveMessage:true });
}

async function initCoursePackSection() {
  const api = globalThis.TACoursePack;
  if (!api || coursePackSectionInitialized) return;
  coursePackSectionInitialized = true;

  toggleCoursePackEnabled?.addEventListener('click', async () => {
    if (toggleCoursePackEnabled.disabled) return;
    const next = !getToggle(toggleCoursePackEnabled);
    setToggle(toggleCoursePackEnabled, next);
    try {
      await saveCoursePackToggle('enabled', next);
      logCoursePackAction('Course Pack mode changed', { enabled:next });
      setCoursePackMessage(next ? t('course_pack.enabled_message') : t('course_pack.disabled_message'), 'success');
    } catch (error) {
      await refreshCoursePackState();
      setCoursePackMessage(getCoursePackErrorMessage(error), 'error');
    }
  });
  toggleCoursePackChat?.addEventListener('click', async () => {
    if (toggleCoursePackChat.disabled) return;
    const next = !getToggle(toggleCoursePackChat);
    setToggle(toggleCoursePackChat, next);
    try { await saveCoursePackToggle('useChat', next); }
    catch (error) {
      await refreshCoursePackState();
      setCoursePackMessage(getCoursePackErrorMessage(error), 'error');
    }
  });
  toggleCoursePackYandex?.addEventListener('click', async () => {
    if (toggleCoursePackYandex.disabled) return;
    const next = !getToggle(toggleCoursePackYandex);
    setToggle(toggleCoursePackYandex, next);
    try { await saveCoursePackToggle('useYandex', next); }
    catch (error) {
      await refreshCoursePackState();
      setCoursePackMessage(getCoursePackErrorMessage(error), 'error');
    }
  });

  coursePackUploadBtn?.addEventListener('click', () => {
    if (!coursePackFileInput) return;
    coursePackFileInput.value = '';
    coursePackFileInput.click();
  });
  coursePackFileInput?.addEventListener('change', async () => {
    const file = coursePackFileInput.files?.[0];
    coursePackFileInput.value = '';
    if (!file) return;
    if (file.size > api.COURSE_PACK_MAX_FILE_BYTES) {
      setCoursePackMessage(t('course_pack.error_too_large'), 'error');
      return;
    }
    coursePackUploadBtn.disabled = true;
    setCoursePackMessage(t('course_pack.loading'), 'info');
    try {
      let raw;
      try { raw = JSON.parse(await file.text()); }
      catch { const error = new Error('invalid_json'); error.code = 'invalid_json'; throw error; }
      const pack = await api.saveCoursePack(raw);
      await refreshCoursePackState();
      logCoursePackAction('Course Pack loaded', {
        courseId:pack.courseId,
        title:pack.title,
        lectureCount:pack.lectures.length,
        chunkCount:pack.chunks.length,
      });
      setCoursePackMessage(t('course_pack.loaded').replace('{title}', pack.title).replace('{chunks}', String(pack.chunks.length)), 'success');
    } catch (error) {
      setCoursePackMessage(getCoursePackErrorMessage(error), 'error');
    } finally {
      coursePackUploadBtn.disabled = false;
    }
  });
  coursePackClearBtn?.addEventListener('click', async () => {
    if (coursePackClearBtn.disabled) return;
    try {
      await api.clearCoursePack();
      await refreshCoursePackState();
      logCoursePackAction('Course Pack cleared');
      setCoursePackMessage(t('course_pack.cleared'), 'success');
    } catch (error) { setCoursePackMessage(getCoursePackErrorMessage(error), 'error'); }
  });

  await refreshCoursePackState();
}

async function loadAllSettings() {
  const data = await chrome.storage.local.get([STORAGE_KEY, 'routeraiApiKey']);
  const s    = readStorageSettings(data);

  apiKeyInput.value = data.routeraiApiKey || '';

  // Pre-load catalog from cache BEFORE applySettingsToUi so setModelInputDisplay
  // can resolve id → name on the very first render (no visible flash of raw ids).
  // getModels() reads chrome.storage.local only — fast, works without an API key.
  if (globalThis.TAModelsService) {
    const [chatResult, imageResult] = await Promise.all([
      globalThis.TAModelsService.getModels({ type: 'chat', forceRefresh: false }),
      globalThis.TAModelsService.getModels({ type: 'image', forceRefresh: false }),
    ]);
    chatModelsCatalog = Array.isArray(chatResult.models) ? chatResult.models : [];
    imageModelsCatalog = Array.isArray(imageResult.models) ? imageResult.models : [];
  }

  applySettingsToUi(s);

  wireModelSelector(modelTextInput, modelTextList, 'text');
  wireModelSelector(modelVisionInput, modelVisionList, 'vision');
  wireMultiSelector();
  await initModelSelectors(s);
  await initPromptsSection();
  await initCoursePackSection();
  initThemesSection(s);
}

function readFormValues() {
  return {
    model_text:               getModelInputId(modelTextInput),
    model_vision:             getModelInputId(modelVisionInput),
    auto_send_screenshot:     getToggle(toggleAutoScreenshot),
    test_mode:                toggleTestMode ? getToggle(toggleTestMode) : DEFAULT_SETTINGS.test_mode,
    save_logs:                getToggle(toggleLogs),
    quiz_show_answer_widget:  toggleQuizShowWidget ? getToggle(toggleQuizShowWidget) : DEFAULT_SETTINGS.quiz_show_answer_widget,
    log_location:             logLocationInput.value.trim() || DEFAULT_SETTINGS.log_location,
    log_location_mode:        logLocationModeSelect ? logLocationModeSelect.value : DEFAULT_SETTINGS.log_location_mode,
    log_filename:             sanitizeLogFilename(logFilenameInput ? logFilenameInput.value : '') || DEFAULT_SETTINGS.log_filename,
    log_save_mode:            logSaveModeSelect ? logSaveModeSelect.value : DEFAULT_SETTINGS.log_save_mode,
    screenshot_temperature:    screenshotTemperatureInput ? Math.max(0, Math.min(1, Number(screenshotTemperatureInput.value) || 0)) : DEFAULT_SETTINGS.screenshot_temperature,
    screenshot_max_tokens:     screenshotMaxTokensInput ? Math.max(32, Math.min(2048, Math.floor(Number(screenshotMaxTokensInput.value) || DEFAULT_SETTINGS.screenshot_max_tokens))) : DEFAULT_SETTINGS.screenshot_max_tokens,
    multi_check_models:       [...currentMultiModels],
    screenshot_multi_check_models: [...currentScreenshotMultiModels],
  };
}

/* ── Model catalog in options ────────────────────────────── */

let chatModelsCatalog = [];
let imageModelsCatalog = [];
let modelFavorites = [];
let modelsLoadSeq = 0;
let modelsRefreshTimer = null;
const dropdownOpenSuppressUntil = new WeakMap();

function updateModelsStatus(msg, isError = false) {
  if (!modelsStatusEl) return;
  modelsStatusEl.textContent = msg;
  modelsStatusEl.style.color = isError ? '#dc2626' : '#64748b';
}

function setModelsUiEnabled(enabled) {
  modelTextInput.disabled = !enabled;
  modelVisionInput.disabled = !enabled;
  if (newMultiModel) newMultiModel.disabled = !enabled;
  if (addMultiModelBtn) addMultiModelBtn.disabled = !enabled;
  if (newScreenshotMultiModel) newScreenshotMultiModel.disabled = !enabled;
  if (addScreenshotMultiModelBtn) addScreenshotMultiModelBtn.disabled = !enabled;
}

function getDropdownHostCard(listEl) {
  return listEl ? listEl.closest('.card.models-card, .card.multi-card') : null;
}

function setDropdownLayerState(listEl, isOpen) {
  const card = getDropdownHostCard(listEl);
  if (!card) return;
  if (isOpen) {
    card.classList.add('model-dropdown-active');
  } else {
    // Only remove elevated z-index if no sibling dropdown in this same card is still open.
    // Both modelTextList and modelVisionList share the same .models-card container,
    // so a blur-timeout from the first field must not strip the class while the second is open.
    const siblingOpen = Array.from(card.querySelectorAll('.model-list'))
      .some(el => el !== listEl && el.style.display !== 'none');
    if (!siblingOpen) {
      card.classList.remove('model-dropdown-active');
    }
  }
}

function showModelDropdown(listEl) {
  listEl.style.display = 'block';
  setDropdownLayerState(listEl, true);
}

function hideModelDropdown(listEl) {
  listEl.style.display = 'none';
  setDropdownLayerState(listEl, false);
}

function suppressDropdownOpen(inputEl, durationMs = 220) {
  dropdownOpenSuppressUntil.set(inputEl, Date.now() + durationMs);
}

function isDropdownOpenSuppressed(inputEl) {
  return (dropdownOpenSuppressUntil.get(inputEl) || 0) > Date.now();
}

function hideModelDropdowns() {
  hideModelDropdown(modelTextList);
  hideModelDropdown(modelVisionList);
  if (multiModelCatalogList) hideModelDropdown(multiModelCatalogList);
  if (screenshotMultiModelCatalogList) hideModelDropdown(screenshotMultiModelCatalogList);
}

function scheduleModelsRefresh(delayMs = 120) {
  if (modelsRefreshTimer) clearTimeout(modelsRefreshTimer);
  modelsRefreshTimer = setTimeout(() => {
    refreshModelsSection().catch((e) => updateModelsStatus(`Не удалось загрузить модели: ${e.message}`, true));
  }, delayMs);
}

function byFavorites(models) {
  return globalThis.TAModelsService.sortByFavorites(models, modelFavorites);
}

function filteredCatalog(kind) {
  if (kind === 'vision' || kind === 'screenshotMulti') {
    return byFavorites(imageModelsCatalog);
  }
  return byFavorites(chatModelsCatalog);
}

function findCatalogModel(modelId) {
  return chatModelsCatalog.find((m) => m.id === modelId)
    || imageModelsCatalog.find((m) => m.id === modelId)
    || null;
}

/** Returns the model id that is currently bound to this input. */
function getModelInputId(inputEl) {
  return inputEl.dataset.modelId || inputEl.value.trim();
}

/**
 * Sets display name in the input and stores the real id in dataset.modelId.
 * If modelId is found in the catalog, shows its name; otherwise shows the raw id.
 */
function setModelInputDisplay(inputEl, modelId) {
  const model = findCatalogModel(modelId);
  if (model) {
    inputEl.value = model.name || model.id;
    inputEl.dataset.modelId = model.id;
  } else {
    const fallback = globalThis.TAModelsService?.MODEL_DISPLAY_NAMES?.[modelId];
    inputEl.value = fallback || modelId || '';
    inputEl.dataset.modelId = modelId || '';
  }
}

/**
 * Called on blur: tries to match whatever is typed to a model by id or name.
 * If matched, replaces display with name and updates dataset.modelId.
 */
function resolveInputToModel(inputEl) {
  const typed = inputEl.value.trim();
  if (!typed) return;
  const currentId = inputEl.dataset.modelId || '';
  const fallbackName = globalThis.TAModelsService?.MODEL_DISPLAY_NAMES?.[currentId];
  if (currentId && typed === (findCatalogModel(currentId)?.name || fallbackName || currentId)) return;
  // Try exact id match (user pasted a raw id)
  const byId = findCatalogModel(typed);
  if (byId) {
    inputEl.value = byId.name || byId.id;
    inputEl.dataset.modelId = byId.id;
    return;
  }
  // Try exact name match
  const all = [...chatModelsCatalog, ...imageModelsCatalog];
  const byName = all.find((m) => (m.name || m.id).toLowerCase() === typed.toLowerCase());
  if (byName) {
    inputEl.value = byName.name || byName.id;
    inputEl.dataset.modelId = byName.id;
  }
  // No match — leave typed text; dataset.modelId stays as-is (previous confirmed value)
}

function renderModelList({ inputEl, listEl, kind, query, keepVisibility = false }) {
  const q = typeof query === 'string' ? query : (listEl.dataset.currentQuery ?? '');
  listEl.dataset.currentQuery = q;
  const base = filteredCatalog(kind);
  const visible = globalThis.TAModelsService.searchModels(base, q);
  const _wasVisible = listEl.style.display !== 'none';
  const _prevScrollTop = _wasVisible ? listEl.scrollTop : 0;
  listEl.innerHTML = '';

  for (const model of visible.slice(0, 200)) {
    const row = document.createElement('div');
    row.className = 'model-option';

    const main = document.createElement('div');
    main.className = 'model-option-main';
    const nm = document.createElement('div');
    nm.className = 'model-option-id';   // bold primary slot — shows human name
    nm.textContent = model.name || model.id;
    const idEl = document.createElement('div');
    idEl.className = 'model-option-name'; // muted secondary slot — shows technical id
    idEl.textContent = model.id;
    const ds = document.createElement('div');
    ds.className = 'model-option-desc';
    ds.textContent = model.short_description || '';
    main.append(nm, idEl, ds);

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'model-star';
    const isFav = modelFavorites.includes(model.id);
    star.textContent = isFav ? '★' : '☆';
    star.title = isFav ? t('common.fav_remove') : t('common.fav_add');
    star.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    star.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      modelFavorites = isFav
        ? modelFavorites.filter((m) => m !== model.id)
        : [...new Set([...modelFavorites, model.id])];
      await savePartialSettings({ model_favorites: modelFavorites, favorite_models: modelFavorites });
      renderModelList({ inputEl: modelTextInput, listEl: modelTextList, kind: 'text', query: modelTextList.dataset.currentQuery ?? '', keepVisibility: true });
      renderModelList({ inputEl: modelVisionInput, listEl: modelVisionList, kind: 'vision', query: modelVisionList.dataset.currentQuery ?? '', keepVisibility: true });
      if (multiModelCatalogList) {
        renderModelList({ inputEl: newMultiModel, listEl: multiModelCatalogList, kind: 'multi', query: multiModelCatalogList.dataset.currentQuery ?? '', keepVisibility: true });
      }
      if (screenshotMultiModelCatalogList) {
        renderModelList({ inputEl: newScreenshotMultiModel, listEl: screenshotMultiModelCatalogList, kind: 'screenshotMulti', query: screenshotMultiModelCatalogList.dataset.currentQuery ?? '', keepVisibility: true });
      }
    });

    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    row.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setModelInputDisplay(inputEl, model.id);
      suppressDropdownOpen(inputEl);
      hideModelDropdown(listEl);
      queueAutoSave();
    });

    row.append(main, star);
    listEl.appendChild(row);
  }

  if (keepVisibility) {
    if (!visible.length) hideModelDropdown(listEl);
    else if (_wasVisible) showModelDropdown(listEl);
    // else: has items but was hidden — leave hidden
  } else {
    if (visible.length) showModelDropdown(listEl);
    else hideModelDropdown(listEl);
  }
  if (_wasVisible && listEl.style.display !== 'none') listEl.scrollTop = _prevScrollTop;
}

function wireModelSelector(inputEl, listEl, kind) {
  inputEl.setAttribute('autocomplete', 'off');
  const openList = (query = '') => {
    if (isDropdownOpenSuppressed(inputEl)) return;
    hideModelDropdowns();
    renderModelList({ inputEl, listEl, kind, query });
  };
  inputEl.addEventListener('focus', () => openList(''));
  inputEl.addEventListener('click', () => openList(''));
  inputEl.addEventListener('input', () => openList(inputEl.value));
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      resolveInputToModel(inputEl);
      hideModelDropdown(listEl);
      queueAutoSave();
    }
    if (e.key === 'Escape') {
      hideModelDropdown(listEl);
    }
  });
  inputEl.addEventListener('blur', () => setTimeout(() => {
    hideModelDropdown(listEl);
    resolveInputToModel(inputEl);
    queueAutoSave();
  }, 120));
}

function wireMultiSelector() {
  if (newMultiModel && multiModelCatalogList) wireModelSelector(newMultiModel, multiModelCatalogList, 'multi');
  if (newScreenshotMultiModel && screenshotMultiModelCatalogList) wireModelSelector(newScreenshotMultiModel, screenshotMultiModelCatalogList, 'screenshotMulti');
}

async function refreshModelsSection({ forceRefresh = false } = {}) {
  if (!globalThis.TAModelsService || !modelTextList || !modelVisionList) return;

  const apiKey = await globalThis.TAModelsService.getApiKey();
  const hasApiKey = Boolean(apiKey);

  if (hasApiKey) {
    setModelsUiEnabled(true);
    updateModelsStatus(t('models.loading'));
  }

  const seq = ++modelsLoadSeq;
  try {
    // Always load (from cache or API) so we can resolve names even without an API key.
    // When hasApiKey=false, getModels() returns cached data without making API calls.
    const [chatResult, imageResult] = await Promise.all([
      globalThis.TAModelsService.getModels({ type: 'chat', forceRefresh }),
      globalThis.TAModelsService.getModels({ type: 'image', forceRefresh }),
    ]);
    if (seq !== modelsLoadSeq) return;

    chatModelsCatalog = Array.isArray(chatResult.models) ? chatResult.models : [];
    imageModelsCatalog = Array.isArray(imageResult.models) ? imageResult.models : [];

    // Resolve ids → names now that catalog is available (works from cache too).
    // Guard: skip if the user has already typed something new into the field —
    // detected by checking that the current value still matches the bound model id
    // (as raw id or as its resolved display name). Prevents async load from
    // overwriting text the user pasted before this promise resolved.
    const _refreshIfUnmodified = (inputEl) => {
      const storedId = inputEl.dataset.modelId;
      const displayedName = findCatalogModel(storedId)?.name
        || globalThis.TAModelsService?.MODEL_DISPLAY_NAMES?.[storedId]
        || storedId;
      if (inputEl.value === storedId || inputEl.value === displayedName) {
        setModelInputDisplay(inputEl, getModelInputId(inputEl));
      }
    };
    _refreshIfUnmodified(modelTextInput);
    _refreshIfUnmodified(modelVisionInput);
    renderMultiModels();
    renderScreenshotMultiModels();

    if (!hasApiKey) {
      setModelsUiEnabled(false);
      hideModelDropdowns();
      updateModelsStatus(t('models.no_api_key'), true);
      return;
    }

    if (!chatModelsCatalog.length && !imageModelsCatalog.length) {
      updateModelsStatus(t('models.list_empty'), true);
      hideModelDropdowns();
      return;
    }

    const fromCache = chatResult.fromCache && imageResult.fromCache;
    const hasError = (chatResult.fromCache && chatResult.error) || (imageResult.fromCache && imageResult.error);
    const totalCount = chatModelsCatalog.length + imageModelsCatalog.length;
    if (hasError) {
      const errMsg = chatResult.error || imageResult.error;
      updateModelsStatus(`Using cached models: ${totalCount}. ${errMsg}`, true);
    } else {
      const chatCount = chatModelsCatalog.length;
      const imageCount = imageModelsCatalog.length;
      const msgKey = fromCache ? 'models.loaded_from_cache' : 'models.loaded_via_api';
      // Compose the status message; fallback to a simple string if key missing
      const baseMsg = fromCache
        ? `Models loaded from cache (<24h): chat — ${chatCount}, image — ${imageCount}.`
        : `Models loaded via API: chat — ${chatCount}, image — ${imageCount}.`;
      updateModelsStatus(t(msgKey) !== msgKey
        ? t(msgKey).replace('{chat}', chatCount).replace('{image}', imageCount)
        : baseMsg);
    }

    renderModelList({ inputEl: modelTextInput, listEl: modelTextList, kind: 'text', query: '' });
    renderModelList({ inputEl: modelVisionInput, listEl: modelVisionList, kind: 'vision', query: '' });
    if (multiModelCatalogList) {
      renderModelList({ inputEl: newMultiModel, listEl: multiModelCatalogList, kind: 'multi', query: '' });
    }
    if (screenshotMultiModelCatalogList) {
      renderModelList({ inputEl: newScreenshotMultiModel, listEl: screenshotMultiModelCatalogList, kind: 'screenshotMulti', query: '' });
    }
    hideModelDropdowns();
  } catch (e) {
    if (seq !== modelsLoadSeq) return;
    updateModelsStatus(t('common.error').replace('{msg}', e.message), true);
  }
}

async function initModelSelectors(settings) {
  if (!globalThis.TAModelsService || !modelTextList || !modelVisionList) return;
  modelFavorites = Array.isArray(settings.model_favorites)
    ? settings.model_favorites
    : (Array.isArray(settings.favorite_models) ? settings.favorite_models : []);
  await refreshModelsSection();
}

/* ── Event listeners ─────────────────────────────────────────────── */

function syncApiKeyVisibilityButton(isVisible) {
  if (eyeBtnIcon) {
    eyeBtnIcon.src = isVisible ? 'assets/options-icons/visibility_off.svg' : 'assets/options-icons/visibility.svg';
  }
  if (eyeBtn) {
    eyeBtn.title = isVisible ? t('api.hide_key') : t('api.show_key');
    eyeBtn.setAttribute('aria-label', eyeBtn.title);
  }
}

eyeBtn.addEventListener('click', () => {
  const isPass = apiKeyInput.type === 'password';
  const isVisible = isPass;
  apiKeyInput.type = isVisible ? 'text' : 'password';
  syncApiKeyVisibilityButton(isVisible);
});

syncApiKeyVisibilityButton(apiKeyInput.type !== 'password');

[toggleAutoScreenshot, toggleTestMode, toggleLogs, toggleQuizShowWidget].filter(Boolean).forEach((btn) => {
  btn.addEventListener('click', () => {
    setToggle(btn, btn.dataset.on !== 'true');
    if (btn === toggleLogs) {
      const logsEnabled = getToggle(toggleLogs);
      const logsVisible = logsEnabled ? 'block' : 'none';
      if (logLocationModeField) logLocationModeField.style.display = logsVisible;
      const isSubfolder = !logLocationModeSelect || logLocationModeSelect.value === 'subfolder';
      logLocationField.style.display = logsEnabled && isSubfolder ? 'block' : 'none';
      if (logFilenameField) logFilenameField.style.display = logsVisible;
      if (logSaveModeField) logSaveModeField.style.display = logsVisible;
      if (logsHotkeyItem) logsHotkeyItem.style.display = logsEnabled ? '' : 'none';
    }
    queueAutoSave();
  });
});

modelTextInput.addEventListener('input', queueAutoSave);
modelVisionInput.addEventListener('input', queueAutoSave);
logLocationInput.addEventListener('input', queueAutoSave);
if (logLocationModeSelect) {
  logLocationModeSelect.addEventListener('change', () => {
    const logsEnabled = getToggle(toggleLogs);
    logLocationField.style.display = logsEnabled && logLocationModeSelect.value === 'subfolder' ? 'block' : 'none';
    queueAutoSave();
  });
}
if (logFilenameInput) logFilenameInput.addEventListener('input', queueAutoSave);
if (logSaveModeSelect) logSaveModeSelect.addEventListener('change', queueAutoSave);
if (screenshotTemperatureInput) screenshotTemperatureInput.addEventListener('input', queueAutoSave);
if (screenshotMaxTokensInput) screenshotMaxTokensInput.addEventListener('input', queueAutoSave);

apiKeyInput.addEventListener('input', () => {
  chrome.storage.local.set({ routeraiApiKey: apiKeyInput.value.trim() })
    .then(() => setStatus(t('common.saved'), 'ok', 1000))
    .catch((e) => setStatus(t('common.error').replace('{msg}', e.message), 'error'));
  scheduleModelsRefresh(220);
});

/* ── Multi-check models ────────────────────────────────────────────── */

const multiModelList = document.getElementById('multiModelList');
const newMultiModel  = document.getElementById('newMultiModel');
const addMultiModelBtn = document.getElementById('addMultiModel');
const multiModelCatalogList = document.getElementById('multiModelCatalogList');

const screenshotMultiModelList = document.getElementById('screenshotMultiModelList');
const newScreenshotMultiModel = document.getElementById('newScreenshotMultiModel');
const addScreenshotMultiModelBtn = document.getElementById('addScreenshotMultiModel');
const screenshotMultiModelCatalogList = document.getElementById('screenshotMultiModelCatalogList');

let currentMultiModels = [...DEFAULT_SETTINGS.multi_check_models];
let currentScreenshotMultiModels = [...DEFAULT_SETTINGS.screenshot_multi_check_models];

function shortName(m) { return String(m || '').split('/').pop() || m; }

function renderMultiModelCollection(listEl, models, onDelete) {
  if (!listEl) return;
  listEl.innerHTML = '';
  models.forEach((m, i) => {
    const meta = findCatalogModel(m);
    const row = document.createElement('div');
    row.className = 'multi-model-row';
    const main = document.createElement('div');
    main.className = 'multi-model-main';
    const nameEl = document.createElement('div');
    nameEl.className = 'multi-model-id';
    nameEl.textContent = meta?.name || globalThis.TAModelsService?.MODEL_DISPLAY_NAMES?.[m] || m;  // human-readable name; falls back to id
    nameEl.title = m;                       // tooltip always shows full id
    const sub = document.createElement('div');
    sub.className = 'multi-model-meta';
    sub.textContent = m;                    // always show full id as secondary reference
    main.append(nameEl, sub);
    // No badge — id is already shown as secondary text
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'multi-model-del';
    del.textContent = '✕';
    del.title = t('multi_check.delete_title');
    del.addEventListener('click', () => onDelete(i));
    row.append(main, del);
    listEl.appendChild(row);
  });
  if (!models.length) {
    const empty = document.createElement('div');
    empty.className = 'multi-model-empty';
    empty.textContent = t('multi_check.no_models');
    listEl.appendChild(empty);
  }
}

function renderMultiModels() {
  renderMultiModelCollection(multiModelList, currentMultiModels, async (i) => {
    currentMultiModels.splice(i, 1);
    renderMultiModels();
    await savePartialSettings({ multi_check_models: [...currentMultiModels] }, t('common.saved'));
  });
}

function renderScreenshotMultiModels() {
  renderMultiModelCollection(screenshotMultiModelList, currentScreenshotMultiModels, async (i) => {
    currentScreenshotMultiModels.splice(i, 1);
    renderScreenshotMultiModels();
    await savePartialSettings({ screenshot_multi_check_models: [...currentScreenshotMultiModels] }, t('common.saved'));
  });
}

async function addCurrentMultiModel() {
  const v = getModelInputId(newMultiModel);  // real id, not display name
  if (!v) return;
  if (currentMultiModels.includes(v)) {
    setStatus(t('multi_check.already_added'), 'info', 1200);
    return;
  }
  currentMultiModels.push(v);
  renderMultiModels();
  await savePartialSettings({ multi_check_models: [...currentMultiModels] }, t('common.saved'));
  newMultiModel.value = '';
  newMultiModel.dataset.modelId = '';
  if (multiModelCatalogList) hideModelDropdown(multiModelCatalogList);
  newMultiModel.focus();
}

async function addCurrentScreenshotMultiModel() {
  const v = getModelInputId(newScreenshotMultiModel);  // real id, not display name
  if (!v) return;
  if (currentScreenshotMultiModels.includes(v)) {
    setStatus(t('multi_check.already_added'), 'info', 1200);
    return;
  }
  currentScreenshotMultiModels.push(v);
  renderScreenshotMultiModels();
  await savePartialSettings({ screenshot_multi_check_models: [...currentScreenshotMultiModels] }, t('common.saved'));
  newScreenshotMultiModel.value = '';
  newScreenshotMultiModel.dataset.modelId = '';
  if (screenshotMultiModelCatalogList) hideModelDropdown(screenshotMultiModelCatalogList);
  newScreenshotMultiModel.focus();
}

addMultiModelBtn.addEventListener('click', () => {
  addCurrentMultiModel().catch((e) => setStatus(t('common.error').replace('{msg}', e.message), 'error'));
});

newMultiModel.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addMultiModelBtn.click(); } });

if (addScreenshotMultiModelBtn) {
  addScreenshotMultiModelBtn.addEventListener('click', () => {
    addCurrentScreenshotMultiModel().catch((e) => setStatus(t('common.error').replace('{msg}', e.message), 'error'));
  });
}

if (newScreenshotMultiModel) {
  newScreenshotMultiModel.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addScreenshotMultiModelBtn?.click(); }
  });
}

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes[STORAGE_KEY]) {
      const next = mergeSettings(changes[STORAGE_KEY].newValue || {});
      applySettingsToUi(next);
      syncThemeState(next);
      applyThemeToPage();
    }

    if (changes.routeraiApiKey) {
      const applyApiKey = async () => {
        try {
          const keyValue = await globalThis.TAModelsService?.getApiKey?.();
          if (document.activeElement !== apiKeyInput) apiKeyInput.value = keyValue || '';
        } catch {}
        scheduleModelsRefresh(0);
      };
      applyApiKey();
    }
  });
}

/* ── Escape closes recording globally ────────────────────────────── */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeRecorder) {
    e.preventDefault();
    stopRecording(null);
  }
});

/* ── Sidebar navigation (panel-based) ───────────────────────────── */

function initSidebarNavigation() {
  const links = Array.from(document.querySelectorAll('.sidebar-link[data-target]'));
  if (!links.length) return null;

  /** id → panel element */
  const panelMap = new Map();
  /** id → sidebar link element */
  const linkById = new Map();

  links.forEach((link) => {
    const id = link.dataset.target;
    const panel = document.getElementById(id);
    if (!id || !panel) return;
    panelMap.set(id, panel);
    linkById.set(id, link);
  });

  if (!panelMap.size) return null;

  let activeId = null;

  /**
   * Show the panel with the given id, hide all others.
   * Updates sidebar link active states.
   */
  function showPanel(id) {
    if (!panelMap.has(id)) return;

    // Hide all panels
    panelMap.forEach((panel) => panel.classList.remove('is-active'));
    // Show target panel (triggers CSS animation via .settings-panel.is-active)
    panelMap.get(id).classList.add('is-active');
    // Update active link highlight
    linkById.forEach((link, linkId) => link.classList.toggle('is-active', linkId === id));

    activeId = id;

    // Scroll the content area back to the top on section switch
    const contentArea = document.querySelector('.content-area');
    if (contentArea) contentArea.scrollTo({ top: 0, behavior: 'instant' });
  }

  // Show the first panel on load
  const firstId = panelMap.keys().next().value;
  if (firstId) showPanel(firstId);

  // Wire sidebar link clicks
  links.forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const id = link.dataset.target;
      if (!panelMap.has(id)) return;
      if (link.classList.contains('is-filtered-out')) return;
      showPanel(id);
    });
  });

  return {
    links,
    sections: Array.from(panelMap.values()),
    showPanel,
    getActiveId: () => activeId,
    syncVisibleGroups() {
      const groups = Array.from(document.querySelectorAll('.sidebar-group'));
      groups.forEach((group) => {
        const hasVisibleLink = Array.from(group.querySelectorAll('.sidebar-link')).some(
          (link) => !link.classList.contains('is-filtered-out'),
        );
        group.classList.toggle('is-filtered-out', !hasVisibleLink);
      });
    },
    setActive(id) { showPanel(id); },
    setFirstVisibleActive() {
      const firstVisible = links.find((l) => !l.classList.contains('is-filtered-out'));
      if (firstVisible) showPanel(firstVisible.dataset.target);
    },
  };
}

function initSettingsSearch(sidebarApi) {
  const input = document.getElementById('settingsSearch');
  const emptyState = document.getElementById('searchEmptyState');
  if (!input || !sidebarApi) return;

  // Build searchable index from panel text content
  const sectionRecords = sidebarApi.sections.map((section) => ({
    section,
    id: section.id,
    searchableText: section.textContent.toLowerCase(),
  }));

  const linkById = new Map(sidebarApi.links.map((link) => [link.dataset.target, link]));

  /** Panel id that was active before search started — restored on clear */
  let savedActiveId = sidebarApi.getActiveId ? sidebarApi.getActiveId() : null;

  const applyQuery = () => {
    const query = input.value.trim().toLowerCase();
    const hasQuery = query.length > 0;
    let visibleCount = 0;
    let firstMatchId = null;

    sectionRecords.forEach(({ id, searchableText }) => {
      const isMatch = !hasQuery || searchableText.includes(query);
      const link = linkById.get(id);
      if (link) link.classList.toggle('is-filtered-out', !isMatch);
      if (isMatch) {
        visibleCount++;
        if (!firstMatchId) firstMatchId = id;
      }
    });

    sidebarApi.syncVisibleGroups();

    if (hasQuery) {
      // Navigate to first matching panel automatically
      if (firstMatchId) sidebarApi.showPanel(firstMatchId);
    } else {
      // Restore panel that was active before search
      if (savedActiveId && panelExists(savedActiveId)) {
        sidebarApi.showPanel(savedActiveId);
      } else {
        sidebarApi.setFirstVisibleActive();
      }
    }

    if (emptyState) emptyState.hidden = !(hasQuery && visibleCount === 0);
  };

  function panelExists(id) {
    return sidebarApi.sections.some((s) => s.id === id);
  }

  // Capture active panel before search starts
  input.addEventListener('focus', () => {
    if (!input.value && sidebarApi.getActiveId) {
      savedActiveId = sidebarApi.getActiveId();
    }
  });

  input.addEventListener('input', applyQuery);
  input.addEventListener('search', applyQuery);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      input.value = '';
      applyQuery();
      input.blur();
    }
  });
}

/* ── Prompts section ─────────────────────────────────────────────── */

/**
 * Renders all prompt cards into #promptList and wires their controls.
 * Called once from loadAllSettings(); internally loads custom overrides
 * from chrome.storage.local via TAPromptsConfig.
 */
async function initPromptsSection() {
  const listEl = document.getElementById('promptList');
  if (!listEl) return;

  const pc = globalThis.TAPromptsConfig;
  if (!pc) return;

  const { PROMPTS_CONFIG, PROMPTS_STORAGE_KEY, getDefaultPrompt } = pc;
  const data = await chrome.storage.local.get([PROMPTS_STORAGE_KEY]);
  const customs = data[PROMPTS_STORAGE_KEY] || {};

  listEl.innerHTML = '';

  for (const prompt of PROMPTS_CONFIG) {
    const isModified = typeof customs[prompt.id] === 'string' && customs[prompt.id].trim() !== '';
    const currentText = isModified ? customs[prompt.id] : prompt.default;

    const card = document.createElement('div');
    card.className = 'prompt-card';
    card.dataset.promptId = prompt.id;

    const promptName = t(`prompts.${prompt.id}.name`) !== `prompts.${prompt.id}.name` ? t(`prompts.${prompt.id}.name`) : prompt.name;
    const promptDesc = t(`prompts.${prompt.id}.desc`) !== `prompts.${prompt.id}.desc` ? t(`prompts.${prompt.id}.desc`) : prompt.description;
    card.innerHTML = `
      <div class="prompt-card-header">
        <span class="prompt-card-title">${escHtml(promptName)}</span>
        <span class="prompt-modified-badge${isModified ? ' visible' : ''}">${escHtml(t('prompts.modified_badge'))}</span>
      </div>
      <p class="prompt-card-desc">${escHtml(promptDesc)}</p>
      <textarea rows="5" spellcheck="false" aria-label="${escHtml(promptName)}">${escHtml(currentText)}</textarea>
      <div class="prompt-card-footer">
        <button class="prompt-reset-btn" type="button" title="${escHtml(t('prompts.reset_btn'))}">${escHtml(t('prompts.reset_btn'))}</button>
      </div>
    `;

    const textarea = card.querySelector('textarea');
    const badge    = card.querySelector('.prompt-modified-badge');
    const resetBtn = card.querySelector('.prompt-reset-btn');

    if (isModified) textarea.classList.add('is-modified');

    // Debounced auto-save on edit
    let saveTimer = null;
    textarea.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const val = textarea.value.trim();
        const def = getDefaultPrompt(prompt.id);
        const existingData = await chrome.storage.local.get([PROMPTS_STORAGE_KEY]);
        const existingCustoms = existingData[PROMPTS_STORAGE_KEY] || {};

        if (val === '' || val === def) {
          delete existingCustoms[prompt.id];
          textarea.classList.remove('is-modified');
          badge.classList.remove('visible');
        } else {
          existingCustoms[prompt.id] = val;
          textarea.classList.add('is-modified');
          badge.classList.add('visible');
        }

        await chrome.storage.local.set({ [PROMPTS_STORAGE_KEY]: existingCustoms });
        setStatus(t('common.saved'), 'ok', 1200);
      }, 600);
    });

    // Reset to default
    resetBtn.addEventListener('click', async () => {
      const existingData = await chrome.storage.local.get([PROMPTS_STORAGE_KEY]);
      const existingCustoms = existingData[PROMPTS_STORAGE_KEY] || {};
      delete existingCustoms[prompt.id];
      await chrome.storage.local.set({ [PROMPTS_STORAGE_KEY]: existingCustoms });
      textarea.value = getDefaultPrompt(prompt.id);
      textarea.classList.remove('is-modified');
      badge.classList.remove('visible');
      setStatus(t('common.saved'), 'ok', 1200);
    });

    listEl.appendChild(card);
  }
}

/* ── Language selector ───────────────────────────────────────────── */

function initLanguageSection() {
  const sel = document.getElementById('uiLanguageSelect');
  if (!sel || !globalThis.TAi18n) return;

  // Set the dropdown to the current active language
  sel.value = globalThis.TAi18n.currentLang;

  // Update option text from translations (for languages where label differs)
  const opts = sel.querySelectorAll('option');
  opts.forEach((opt) => {
    if (opt.dataset.i18n) opt.textContent = t(opt.dataset.i18n);
  });

  sel.addEventListener('change', async () => {
    const lang = sel.value;
    await globalThis.TAi18n.setLanguage(lang);
    // Apply static translations
    globalThis.TAi18n.applyTranslations(document);
    // Re-apply the option labels (applyTranslations handles data-i18n on option elements)
    // Re-render dynamic model lists so their strings update
    renderMultiModels();
    renderScreenshotMultiModels();
    // Re-init prompts to update reset button labels
    initPromptsSection().catch(() => {});
  });
}

/* ── Themes section ──────────────────────────────────────────────── */

/**
 * Default theme settings (mirrors settingsStorage.js defaults).
 */
const THEME_DEFAULTS = {
  theme_enabled: false,
  theme_scope: 'global',
  theme_global_preset: 'default',
  theme_global_custom: {},
  theme_surfaces: {
    widget:   { preset: 'default', custom: {} },
    popup:    { preset: 'default', custom: {} },
    settings: { preset: 'default', custom: {} },
    inpage:   { preset: 'default', custom: {} },
  },
  chameleon_enabled: false,
  chameleon_scope: 'widget_inpage',
  chameleon_strength: 'medium',
};

const SURFACE_KEYS = ['widget', 'popup', 'settings', 'inpage'];

/** Current in-memory theme state (loaded on boot, updated on change). */
let themeState = JSON.parse(JSON.stringify(THEME_DEFAULTS));

/** Save theme-related settings. */
async function saveThemeSettings(partial) {
  await savePartialSettings(partial, t('common.saved'));
}

/** Rebuild the themeState from loaded settings. */
function syncThemeState(settings) {
  themeState.theme_enabled            = settings.theme_enabled            ?? THEME_DEFAULTS.theme_enabled;
  themeState.theme_scope              = settings.theme_scope              ?? THEME_DEFAULTS.theme_scope;
  themeState.theme_global_preset      = settings.theme_global_preset      ?? THEME_DEFAULTS.theme_global_preset;
  themeState.theme_global_custom      = settings.theme_global_custom      ?? {};
  themeState.chameleon_enabled        = settings.chameleon_enabled        ?? THEME_DEFAULTS.chameleon_enabled;
  themeState.chameleon_scope          = settings.chameleon_scope          ?? THEME_DEFAULTS.chameleon_scope;
  themeState.chameleon_strength       = settings.chameleon_strength       ?? THEME_DEFAULTS.chameleon_strength;

  const storedSurfaces = settings.theme_surfaces || {};
  for (const surf of SURFACE_KEYS) {
    themeState.theme_surfaces[surf] = {
      preset: storedSurfaces[surf]?.preset || 'default',
      custom: storedSurfaces[surf]?.custom || {},
    };
  }
}

/** Apply the current themeState to the settings page DOM. */
function applyThemeToPage() {
  if (!globalThis.TAThemeEngine) return;
  const eng = globalThis.TAThemeEngine;
  const MAPPING_ID = 'qm-options-var-map';
  if (themeState.theme_enabled) {
    let presetName, customOverrides;
    if (themeState.theme_scope === 'per_surface') {
      const s = themeState.theme_surfaces['settings'];
      presetName = s.preset || 'default';
      customOverrides = s.custom || {};
    } else {
      presetName = themeState.theme_global_preset || 'default';
      customOverrides = themeState.theme_global_custom || {};
    }
    const vars = eng.generateVars(presetName, customOverrides);
    eng.applyToDocumentRoot(vars);
    // Map --qm-* vars to the options page's native variable names
    let mapEl = document.getElementById(MAPPING_ID);
    if (!mapEl) {
      mapEl = document.createElement('style');
      mapEl.id = MAPPING_ID;
      document.head.appendChild(mapEl);
    }
    mapEl.textContent = `:root{` +
      `--bg:var(--qm-bg);` +
      `--surface:var(--qm-surface);` +
      `--text:var(--qm-text);` +
      `--text-2:var(--qm-text-2);` +
      `--muted:var(--qm-muted);` +
      `--border:var(--qm-border);` +
      `--border-dark:var(--qm-border);` +
      `--blue:var(--qm-accent);` +
      `--blue-light:var(--qm-accent-light);` +
      `--blue-hover:var(--qm-accent);` +
      `--green:var(--qm-success);` +
      `--shadow:var(--qm-shadow);` +
      `--shadow-sm:var(--qm-shadow);` +
      `--radius:var(--qm-radius);` +
    `}` +
    // Override hardcoded backgrounds/borders that don't inherit CSS variables
    `.sidebar-column{background:var(--surface)!important;border-color:var(--border)!important;}` +
    `.sidebar-logo{border-bottom-color:var(--border)!important;background:transparent!important;}` +
    `.settings-search{border-bottom-color:var(--border)!important;background:transparent!important;}` +
    `.sidebar-group-title{color:var(--muted)!important;}` +
    `.sidebar-group+.sidebar-group{border-top-color:var(--border)!important;}` +
    `.sidebar-link:hover{background:var(--blue-light)!important;color:var(--blue)!important;box-shadow:inset 0 0 0 1px var(--border)!important;}` +
    `.sidebar-link.is-active{background:var(--blue-light)!important;color:var(--blue)!important;box-shadow:inset 0 0 0 1px var(--border)!important;}` +
    `#settingsSearch{background:var(--surface)!important;border-color:var(--border-dark)!important;color:var(--text)!important;}` +
    `#settingsSearch::placeholder{color:var(--muted)!important;}` +
    `.card{background:var(--surface)!important;border-color:var(--border)!important;}` +
    `.card-header{background:var(--bg)!important;border-bottom-color:var(--border)!important;}` +
    `.card-header-icon{color:var(--text-2)!important;}` +
    `.card-header-icon img{filter:var(--qm-icon-filter,none)!important;}` +
    `.eye-btn-icon{filter:var(--qm-icon-filter,none)!important;}` +
    `.toggle-row{border-bottom-color:var(--border)!important;}` +
    `.model-list{background:var(--surface)!important;border-color:var(--border-dark)!important;}` +
    `.model-option{border-bottom-color:var(--border)!important;}` +
    `.model-option:hover{background:var(--bg)!important;}` +
    `.multi-model-row{background:var(--surface)!important;border-color:var(--border)!important;}` +
    `.multi-model-id{color:var(--text-2)!important;}` +
    `.multi-model-meta{color:var(--muted)!important;}` +
    `.multi-model-del{color:var(--muted)!important;}` +
    `input:focus,select:focus{background:var(--surface)!important;}` +
    `body{background:radial-gradient(circle at 50% -200px,var(--blue-light) 0%,transparent 55%),var(--bg)!important;}`;
  } else {
    eng.removeFromDocumentRoot();
    document.getElementById(MAPPING_ID)?.remove();
  }
}

/* ── Preset chip rendering ───────────────────────────────── */

/**
 * Render preset chips into a container.
 * @param {HTMLElement} container
 * @param {string} activeName  currently selected preset key
 * @param {function(name:string)} onSelect  callback when a chip is clicked
 */
function renderPresetChips(container, activeName, onSelect) {
  if (!container) return;
  const eng = globalThis.TAThemeEngine;
  if (!eng) return;

  container.innerHTML = '';

  for (const [key, preset] of Object.entries(eng.PRESETS)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'theme-preset-chip' + (key === activeName ? ' is-active' : '');
    chip.dataset.preset = key;
    chip.title = t(preset.labelKey) || preset.label;

    // Mini preview swatch
    const preview = document.createElement('div');
    preview.className = 'theme-preset-preview';

    const colors = [
      preset.preview?.bg || preset.vars['--qm-bg'],
      preset.preview?.surface || preset.vars['--qm-surface'],
      preset.preview?.accent || preset.vars['--qm-accent'],
      preset.vars['--qm-border'],
    ];

    colors.forEach((color) => {
      const swatch = document.createElement('span');
      swatch.className = 'theme-preset-preview-swatch';
      swatch.style.background = color;
      preview.appendChild(swatch);
    });

    const name = document.createElement('span');
    name.className = 'theme-preset-name';
    name.textContent = t(preset.labelKey) || preset.label;

    chip.appendChild(preview);
    chip.appendChild(name);

    chip.addEventListener('click', () => {
      container.querySelectorAll('.theme-preset-chip').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      onSelect(key);
    });

    container.appendChild(chip);
  }
}

/* ── Custom color rows ───────────────────────────────────── */

/**
 * Render custom color override rows into a container.
 * @param {HTMLElement} container
 * @param {string} presetName  current preset (for fallback display)
 * @param {Object} customOverrides  current custom overrides {token: value}
 * @param {function(token, value)} onChange
 */
function renderColorRows(container, presetName, customOverrides, onChange) {
  if (!container) return;
  const eng = globalThis.TAThemeEngine;
  if (!eng) return;

  container.innerHTML = '';
  const preset = eng.getPreset(presetName);
  const colorKeys = eng.COLOR_TOKEN_KEYS;

  for (const token of colorKeys) {
    const tokenMeta = eng.TOKEN_LABELS[token];
    const label = t(tokenMeta?.key) || tokenMeta?.label || token;
    const presetValue = preset.vars[token] || '';
    const currentCustom = customOverrides[token] || '';

    // Only show color picker for solid colors (not gradients/shadows)
    // Use the preset value as base color for the picker
    const pickerBaseColor = currentCustom || presetValue;
    // Try to extract a hex color from rgba/rgb/hex
    const hexColor = cssColorToHex(pickerBaseColor) || '#ffffff';

    const row = document.createElement('div');
    row.className = 'theme-color-row';

    const lbl = document.createElement('label');
    lbl.htmlFor = `theme-color-${token.replace(/--/g, '')}`;
    lbl.textContent = label;

    const wrap = document.createElement('div');
    wrap.className = 'theme-color-input-wrap';

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'theme-color-picker';
    picker.id = `theme-color-${token.replace(/--/g, '')}`;
    picker.value = hexColor;
    picker.title = label;
    if (currentCustom) {
      picker.style.outline = '2px solid #2563eb';
    }

    picker.addEventListener('input', () => {
      picker.style.outline = '2px solid #2563eb';
      clearBtn.style.display = 'flex';
      onChange(token, picker.value);
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'theme-color-clear';
    clearBtn.title = 'Reset to preset default';
    clearBtn.textContent = '×';
    clearBtn.style.display = currentCustom ? 'flex' : 'none';

    clearBtn.addEventListener('click', () => {
      picker.value = cssColorToHex(presetValue) || '#ffffff';
      picker.style.outline = '';
      clearBtn.style.display = 'none';
      onChange(token, '');
    });

    wrap.appendChild(picker);
    wrap.appendChild(clearBtn);

    row.appendChild(lbl);
    row.appendChild(wrap);
    container.appendChild(row);
  }
}

/**
 * Attempt to convert a CSS color string to #RRGGBB hex.
 * Handles: #hex, rgb(), rgba(), simple named colors.
 */
function cssColorToHex(colorStr) {
  if (!colorStr) return null;
  const s = String(colorStr).trim();

  // Already hex
  if (/^#[0-9a-f]{3,8}$/i.test(s)) {
    // Normalize to 6-char hex
    if (s.length === 4) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    if (s.length === 7 || s.length === 9) return s.slice(0, 7);
    return null;
  }

  // rgb(r,g,b) or rgba(r,g,b,a)
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    return '#' + [m[1], m[2], m[3]].map((n) => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
  }

  // Try canvas trick for named colors (only in browser context)
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = s;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    if (d[3] === 0) return null; // transparent
    return '#' + [d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/* ── Surface panels ──────────────────────────────────────── */

let activeSurface = 'widget';

/**
 * Render per-surface panels. Each shows:
 *  - Preset chips
 *  - Custom color rows
 */
function renderSurfacePanels() {
  const eng = globalThis.TAThemeEngine;
  if (!eng) return;

  const container = document.getElementById('themeSurfacePanels');
  if (!container) return;
  container.innerHTML = '';

  for (const surf of SURFACE_KEYS) {
    const panel = document.createElement('div');
    panel.className = 'theme-surface-panel' + (surf === activeSurface ? ' is-active' : '');
    panel.id = `theme-surface-panel-${surf}`;

    // Preset label
    const presetLabel = document.createElement('div');
    presetLabel.className = 'theme-subsection-title';
    presetLabel.dataset.i18n = 'themes.preset_label';
    presetLabel.textContent = t('themes.preset_label');

    // Preset chips
    const chipsContainer = document.createElement('div');
    chipsContainer.className = 'theme-presets-grid';
    chipsContainer.id = `theme-surface-presets-${surf}`;

    const surfState = themeState.theme_surfaces[surf];
    renderPresetChips(chipsContainer, surfState.preset, async (presetName) => {
      themeState.theme_surfaces[surf].preset = presetName;
      // Re-render color rows with new preset base colors
      const rowsContainer = document.getElementById(`theme-surface-colors-${surf}`);
      if (rowsContainer) {
        renderColorRows(rowsContainer, presetName, themeState.theme_surfaces[surf].custom, async (token, value) => {
          if (value === '') {
            delete themeState.theme_surfaces[surf].custom[token];
          } else {
            themeState.theme_surfaces[surf].custom[token] = value;
          }
          await saveThemeSettings({ theme_surfaces: themeState.theme_surfaces });
          applyThemeToPage();
        });
      }
      await saveThemeSettings({ theme_surfaces: themeState.theme_surfaces });
      applyThemeToPage();
    });

    // Custom colors toggle + rows
    const customTitle = document.createElement('div');
    customTitle.className = 'theme-subsection-title';
    customTitle.dataset.i18n = 'themes.custom_colors_label';
    customTitle.textContent = t('themes.custom_colors_label');

    const customHint = document.createElement('p');
    customHint.className = 'hint';
    customHint.dataset.i18n = 'themes.custom_colors_hint';
    customHint.textContent = t('themes.custom_colors_hint');
    customHint.style.marginBottom = '8px';

    const colorRows = document.createElement('div');
    colorRows.id = `theme-surface-colors-${surf}`;

    renderColorRows(colorRows, surfState.preset, surfState.custom, async (token, value) => {
      if (value === '') {
        delete themeState.theme_surfaces[surf].custom[token];
      } else {
        themeState.theme_surfaces[surf].custom[token] = value;
      }
      await saveThemeSettings({ theme_surfaces: themeState.theme_surfaces });
      applyThemeToPage();
    });

    const resetSurfBtn = document.createElement('button');
    resetSurfBtn.type = 'button';
    resetSurfBtn.className = 'btn-secondary';
    resetSurfBtn.dataset.i18n = 'themes.reset_surface';
    resetSurfBtn.textContent = t('themes.reset_surface');
    resetSurfBtn.style.fontSize = '11px';
    resetSurfBtn.style.marginTop = '10px';

    resetSurfBtn.addEventListener('click', async () => {
      themeState.theme_surfaces[surf] = { preset: 'default', custom: {} };
      await saveThemeSettings({ theme_surfaces: themeState.theme_surfaces });
      renderSurfacePanels();
      applyThemeToPage();
    });

    panel.appendChild(presetLabel);
    panel.appendChild(chipsContainer);
    panel.appendChild(customTitle);
    panel.appendChild(customHint);
    panel.appendChild(colorRows);
    panel.appendChild(resetSurfBtn);
    container.appendChild(panel);
  }
}

/* ── Section wiring ──────────────────────────────────────── */

function updateThemeScopeVisibility() {
  const scope = themeState.theme_scope;
  const globalSec = document.getElementById('themeGlobalSection');
  const surfSec = document.getElementById('themeSurfacesSection');
  if (globalSec) globalSec.style.display = scope === 'global' ? '' : 'none';
  if (surfSec) surfSec.style.display = scope === 'per_surface' ? '' : 'none';
}

function updateThemeControlsVisibility() {
  const controls = document.getElementById('themeControls');
  if (controls) controls.style.display = themeState.theme_enabled ? '' : 'none';
}

function updateChameleonControlsVisibility() {
  const controls = document.getElementById('chameleonControls');
  if (controls) controls.style.display = themeState.chameleon_enabled ? '' : 'none';
}

/**
 * Initialize the Themes section. Called from bootOptions() after loadAllSettings().
 */
function initThemesSection(settings) {
  const eng = globalThis.TAThemeEngine;
  if (!eng) return;

  syncThemeState(settings);

  const toggleThemeEnabled = document.getElementById('toggleThemeEnabled');
  const toggleChameleon = document.getElementById('toggleChameleon');
  const themeScope = document.getElementById('themeScope');
  const chameleonScope = document.getElementById('chameleonScope');
  const chameleonStrength = document.getElementById('chameleonStrength');
  const themeGlobalPresets = document.getElementById('themeGlobalPresets');
  const themeGlobalCustomColors = document.getElementById('themeGlobalCustomColors');
  const themeGlobalColorRows = document.getElementById('themeGlobalColorRows');
  const btnResetTheme = document.getElementById('btnResetTheme');
  const btnResetChameleon = document.getElementById('btnResetChameleon');
  const surfaceTabs = document.getElementById('themeSurfaceTabs');

  if (!toggleThemeEnabled || !toggleChameleon) return;

  // ── Apply initial state to controls ──

  setToggle(toggleThemeEnabled, themeState.theme_enabled);
  setToggle(toggleChameleon, themeState.chameleon_enabled);
  if (themeScope) themeScope.value = themeState.theme_scope;
  if (chameleonScope) chameleonScope.value = themeState.chameleon_scope;
  if (chameleonStrength) chameleonStrength.value = themeState.chameleon_strength;

  updateThemeControlsVisibility();
  updateChameleonControlsVisibility();
  updateThemeScopeVisibility();

  // Render global preset chips
  renderPresetChips(themeGlobalPresets, themeState.theme_global_preset, async (presetName) => {
    themeState.theme_global_preset = presetName;
    // Re-render color rows with new preset
    renderColorRows(
      themeGlobalColorRows,
      presetName,
      themeState.theme_global_custom,
      handleGlobalColorChange,
    );
    await saveThemeSettings({ theme_global_preset: presetName });
    applyThemeToPage();
  });

  // Render global custom color rows
  renderColorRows(
    themeGlobalColorRows,
    themeState.theme_global_preset,
    themeState.theme_global_custom,
    handleGlobalColorChange,
  );

  // Show custom colors only when there are overrides
  refreshGlobalCustomVisibility();

  // Render per-surface panels
  renderSurfacePanels();

  // ── Event listeners ──

  // Master toggle
  toggleThemeEnabled.addEventListener('click', async () => {
    themeState.theme_enabled = !themeState.theme_enabled;
    setToggle(toggleThemeEnabled, themeState.theme_enabled);
    updateThemeControlsVisibility();
    await saveThemeSettings({ theme_enabled: themeState.theme_enabled });
    applyThemeToPage();
  });

  // Scope selector
  if (themeScope) {
    themeScope.addEventListener('change', async () => {
      themeState.theme_scope = themeScope.value;
      updateThemeScopeVisibility();
      await saveThemeSettings({ theme_scope: themeState.theme_scope });
      applyThemeToPage();
    });
  }

  // Surface tabs
  if (surfaceTabs) {
    surfaceTabs.querySelectorAll('.theme-surface-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        activeSurface = tab.dataset.surface;
        surfaceTabs.querySelectorAll('.theme-surface-tab').forEach((t2) => t2.classList.remove('is-active'));
        tab.classList.add('is-active');
        document.querySelectorAll('.theme-surface-panel').forEach((p) => p.classList.remove('is-active'));
        const panel = document.getElementById(`theme-surface-panel-${activeSurface}`);
        if (panel) panel.classList.add('is-active');
      });
    });
  }

  // Chameleon toggle
  toggleChameleon.addEventListener('click', async () => {
    themeState.chameleon_enabled = !themeState.chameleon_enabled;
    setToggle(toggleChameleon, themeState.chameleon_enabled);
    updateChameleonControlsVisibility();
    await saveThemeSettings({ chameleon_enabled: themeState.chameleon_enabled });
  });

  // Chameleon controls
  if (chameleonScope) {
    chameleonScope.addEventListener('change', async () => {
      themeState.chameleon_scope = chameleonScope.value;
      await saveThemeSettings({ chameleon_scope: themeState.chameleon_scope });
    });
  }

  if (chameleonStrength) {
    chameleonStrength.addEventListener('change', async () => {
      themeState.chameleon_strength = chameleonStrength.value;
      await saveThemeSettings({ chameleon_strength: themeState.chameleon_strength });
    });
  }

  // Reset all themes
  if (btnResetTheme) {
    btnResetTheme.addEventListener('click', async () => {
      Object.assign(themeState, {
        theme_enabled: false,
        theme_scope: 'global',
        theme_global_preset: 'default',
        theme_global_custom: {},
        theme_surfaces: {
          widget:   { preset: 'default', custom: {} },
          popup:    { preset: 'default', custom: {} },
          settings: { preset: 'default', custom: {} },
          inpage:   { preset: 'default', custom: {} },
        },
      });
      await saveThemeSettings({
        theme_enabled: false,
        theme_scope: 'global',
        theme_global_preset: 'default',
        theme_global_custom: {},
        theme_surfaces: themeState.theme_surfaces,
      });
      setToggle(toggleThemeEnabled, false);
      updateThemeControlsVisibility();
      if (themeScope) themeScope.value = 'global';
      updateThemeScopeVisibility();
      renderPresetChips(themeGlobalPresets, 'default', async (presetName) => {
        themeState.theme_global_preset = presetName;
        renderColorRows(themeGlobalColorRows, presetName, themeState.theme_global_custom, handleGlobalColorChange);
        await saveThemeSettings({ theme_global_preset: presetName });
        applyThemeToPage();
      });
      renderColorRows(themeGlobalColorRows, 'default', {}, handleGlobalColorChange);
      renderSurfacePanels();
      applyThemeToPage();
      setStatus(t('themes.reset_done'), 'ok', 2000);
    });
  }

  // Reset chameleon
  if (btnResetChameleon) {
    btnResetChameleon.addEventListener('click', async () => {
      themeState.chameleon_enabled = false;
      themeState.chameleon_scope = 'widget_inpage';
      themeState.chameleon_strength = 'medium';
      setToggle(toggleChameleon, false);
      updateChameleonControlsVisibility();
      if (chameleonScope) chameleonScope.value = 'widget_inpage';
      if (chameleonStrength) chameleonStrength.value = 'medium';
      await saveThemeSettings({
        chameleon_enabled: false,
        chameleon_scope: 'widget_inpage',
        chameleon_strength: 'medium',
      });
      setStatus(t('themes.reset_done'), 'ok', 2000);
    });
  }

  // Apply theme to the current page
  applyThemeToPage();
}

async function handleGlobalColorChange(token, value) {
  if (value === '') {
    delete themeState.theme_global_custom[token];
  } else {
    themeState.theme_global_custom[token] = value;
  }
  refreshGlobalCustomVisibility();
  await saveThemeSettings({ theme_global_custom: themeState.theme_global_custom });
  applyThemeToPage();
}

function refreshGlobalCustomVisibility() {
  const customColors = document.getElementById('themeGlobalCustomColors');
  if (!customColors) return;
  const hasOverrides = Object.values(themeState.theme_global_custom).some(Boolean);
  customColors.classList.toggle('is-visible', hasOverrides);
  // Always show (make it visible) — the hint explains it
  customColors.classList.add('is-visible');
}

/* ── Boot ────────────────────────────────────────────────────────── */

async function bootOptions() {
  // Load language first so all subsequent rendering uses the right language
  if (globalThis.TAi18n) {
    await globalThis.TAi18n.loadLanguage();
    globalThis.TAi18n.applyTranslations(document);
  }

  const sidebarNavigationApi = initSidebarNavigation();
  initSettingsSearch(sidebarNavigationApi);

  await loadAllSettings().catch((e) => setStatus(t('common.error').replace('{msg}', e.message), 'error'));

  initLanguageSection();
}

bootOptions().catch((e) => setStatus(t('common.error').replace('{msg}', e.message), 'error'));
