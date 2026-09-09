/**
 * content.js  v2.2
 * Fixes applied on top of v2.1:
 *  A. Answer window saves AND restores SIZE (not just position)
 *  B. Answer loader (fl) appears at saved answer-window position, not always in corner
 *  C. Multi-check loader (mloader) appears at saved multi position, not always in corner
 *  D. Multi-check & answer windows fully independent:
 *       - Default (no saved pos): multi appears above answer window
 *       - Custom (user saved pos): each window at its own saved position
 *  E. Answer window: fully rounded corners (border-radius: 24px)
 *  F. Removed atBottom guard in persistWindowRect so size is always saved
 */
(() => {
  const BUILD_ID = `2026-03-08-${Date.now()}`;
  const prevInstance = window.__QUIZMIND_INSTANCE__;
  if (prevInstance?.destroy) {
    console.log('[QuizMind] destroying previous instance', prevInstance.buildId || 'unknown');
    try { prevInstance.destroy(); }
    catch (e) { console.warn('[QuizMind] previous instance destroy failed', e); }
  }
  console.log('[QuizMind] LIVE authoritative content.js build', BUILD_ID);

  // i18n helper — uses TAi18n if loaded, falls back to key
  function ct(key) {
    return globalThis.TAi18n?.t(key) ?? key;
  }

  /* ── Markdown/LaTeX renderer from content/qm-markdown.js ───────────── */
  const renderMarkdown      = window.__QM_MARKDOWN?.renderMarkdown      ?? (t => String(t || ''));
  const normalizeAnswerText = window.__QM_MARKDOWN?.normalizeAnswerText ?? (t => String(t || ''));

  const managedCleanups = [];
  function addCleanup(fn) { if (typeof fn === 'function') managedCleanups.push(fn); }
  function addManagedListener(target, type, handler, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    addCleanup(() => target.removeEventListener(type, handler, options));
  }
  function addManagedChromeListener(eventObj, handler) {
    if (!eventObj?.addListener) return;
    eventObj.addListener(handler);
    addCleanup(() => { try { eventObj.removeListener?.(handler); } catch {} });
  }

  function purgeLegacyUiHosts() {
    const selectors = [
      '.ta-helper-shadow-host',
      '.quizmind-settings-shadow-host',
      '.quizmind-multi-shadow-host',
    ];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        try { node.remove(); } catch {}
      }
    }
  }

  purgeLegacyUiHosts();

  /* ═══ CONSTANTS ═══════════════════════════════════════════════════ */
  const WIDGET_MIN_SEL      = 10;
  const YANDEX_QUESTION_MAX_CHARS = 12_000;
  const ANSWER_VIEWPORT_MARGIN = 12;
  const ANSWER_ULTRA_COMPACT_MIN_WIDTH = 76;
  const ANSWER_COMPACT_MIN_WIDTH = 120;
  const ANSWER_COMPACT_MAX_WIDTH = 420;
  const HISTORY_MAX         = 5;
  const HISTORY_STORAGE_KEY = 'ta_answer_history';
  const CHAT_HISTORY_KEY    = 'quizmind_chat_history_v1';
  const CHAT_HISTORY_SEND_LIMIT = 20;
  const CHAT_HISTORY_STORE_LIMIT = 100;
  const CHAT_MESSAGE_MAX_CHARS = 20_000;
  const MAX_PENDING_CHAT_IMAGES = 4;
  const MAX_CHAT_IMAGE_SIDE = 1280;
  const MAX_CHAT_IMAGE_BYTES = 800 * 1024;
  const MAX_CHAT_IMAGE_DATA_URL_CHARS = 1_100_000;
  const MAX_CHAT_HISTORY_IMAGE_CHARS = 4_500_000;
  const MAX_PENDING_CHAT_FILES = 3;
  const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024;
  const MAX_TOTAL_PENDING_CHAT_FILE_BYTES = 12 * 1024 * 1024;
  const CHAT_HISTORY_FILE_DATA_BUDGET_BYTES = 12 * 1024 * 1024;
  const MAX_CHAT_FILE_DATA_URL_CHARS = Math.ceil(MAX_CHAT_FILE_BYTES * 4 / 3) + 512;
  const CHAT_NON_IMAGE_FILE_MIME_BY_EXTENSION = Object.freeze({
    pdf:'application/pdf',
    doc:'application/msword',
    docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt:'text/plain',
    md:'text/markdown',
    csv:'text/csv',
    json:'application/json',
    xml:'application/xml',
    xls:'application/vnd.ms-excel',
    xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt:'application/vnd.ms-powerpoint',
    pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
  const CHAT_IMAGE_MIME_BY_EXTENSION = Object.freeze({ png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp' });
  const CHAT_ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
    ...Object.values(CHAT_NON_IMAGE_FILE_MIME_BY_EXTENSION),
    ...Object.values(CHAT_IMAGE_MIME_BY_EXTENSION),
    'text/x-markdown', 'text/json', 'text/xml', 'application/csv', 'text/comma-separated-values',
    'application/vnd.ms-word', 'application/xls', 'application/x-excel', 'application/mspowerpoint',
  ]);
  const CHAT_FILE_INPUT_ACCEPT = [
    ...Object.keys(CHAT_NON_IMAGE_FILE_MIME_BY_EXTENSION),
    ...Object.keys(CHAT_IMAGE_MIME_BY_EXTENSION),
  ].map(extension => `.${extension}`).concat([
    ...new Set([...Object.values(CHAT_NON_IMAGE_FILE_MIME_BY_EXTENSION), ...Object.values(CHAT_IMAGE_MIME_BY_EXTENSION)]),
  ]).join(',');
  const CHAT_CONTACT_SHEET_MAX_SIDE = 1800;
  const CHAT_CONTACT_SHEET_MAX_BYTES = 1024 * 1024;
  const CHAT_CONTACT_SHEET_MAX_DATA_URL_CHARS = 1_400_000;
  const CHAT_IMAGE_DEFAULT_PROMPT = 'Please analyze the attached image.';
  const CHAT_CONTACT_SHEET_INSTRUCTION_EN = 'The attached image is a contact sheet containing multiple screenshots labeled Image 1, Image 2, etc. Answer each screenshot separately.';
  const CHAT_CONTACT_SHEET_INSTRUCTION_RU = 'Прикреплённое изображение — это коллаж из нескольких скриншотов, подписанных Image 1, Image 2 и т.д. Ответь по каждому скриншоту отдельно.';
  const CHAT_PDF_OCR_PLUGINS = Object.freeze([
    Object.freeze({ id:'file-parser', pdf:Object.freeze({ engine:'mistral-ocr' }) }),
  ]);
  const CHAT_PDF_PARSE_FAILURE_PATTERNS = Object.freeze([
    /не\s+(?:удалось\s+)?извлеч(?:ь|[её]н)\s+текст/i,
    /пуст(?:ые|ых|ыми)\s+страниц/i,
    /только\s+(?:[\d\s]+)?(?:пуст(?:ые|ых)\s+страниц(?:ы|ах)?\s+и\s+)?метаданн/i,
    /(?:нужен|нужно|требуется)\s+ocr/i,
    /ocr[-\s]?распознаван/i,
    /страниц(?:а|ы|ах)?\s+не\s+распознан/i,
    /\bno text (?:(?:was|could be) )?extracted\b/i,
    /\bcould not extract (?:the )?text\b/i,
    /\bunable to (?:read|parse) (?:the )?pdf\b/i,
    /\bpdf appears to contain no text\b/i,
    /\bonly\s+(?:\d+\s+)?empty pages\b/i,
    /\b(?:metadata only|only metadata)\b/i,
    /\bocr (?:is )?required\b/i,
  ]);
  const WINDOW_STATE_KEY    = 'ta_window_state';
  const WINDOW_STATE_ZONE_KEY = 'ta_window_state_zone';
  const WINDOW_KEYS = {
    answer:  'quizmind_window_answer',
    history: 'quizmind_window_history',
    chat:    'quizmind_window_chat',
    multi:   'quizmind_window_multi',
    logs:    'quizmind_window_logs',
  };
  const WIDGET_ICON_BASE = 'assets/widget-icons';
  const WINDOW_ICON_BASE = 'assets/window-icons';
  const WIDGET_ICONS = {
    timer: 'timer.svg',
    activityZone: 'activity-zone.svg',
    multiCheck: 'search-check-2.svg',
    developerMode: 'deployed-code-account.svg',
    screenshotSettings: 'screenshot-monitor.svg',
    testMode: 'science.svg',
    settings: 'settings.svg',
    logs: 'download.svg',
    documentScanner: 'document-scanner.svg',
  };
  const WINDOW_ICONS = {
    close: 'close.svg',
    keep: 'keep.svg',
    keepOff: 'keep-off.svg',
    history: 'history.svg',
    chat: 'chat.svg',
  };
  let WIDGET_TIMER_MS = 5_000;
  const widgetIconSvgCache = new Map();
  const windowIconSvgCache = new Map();
  const chatContactSheetCache = new Map();

  /* ═══ STATE ════════════════════════════════════════════════════════ */
  let actionButton       = null;
  let selectionSnapshot  = null;
  let shadowHost         = null;
  let we                 = null;
  let multiHost          = null;
  let me                 = null;
  let settingsHost       = null;
  let settingsEl         = null;
  let settingsVisible    = false;
  let isDestroyed        = false;
  let answerTimer        = null;  // TimerController instance (created in ensureWidget)
  let isHovered          = false;
  let selHighlights      = [];
  let screenshotSess     = null;
  let activeCtrl         = null;
  const ansHistory       = [];
  let lastQuestionText   = '';
  let histIdx            = -1;
  let widgetSide         = 'right';
  let activeZone         = 'right';
  let widgetPinned       = false;
  let extensionEnabled   = true;
  let windowLayoutState  = { answer:null, answerCustomized:false, history:null, chat:null, multi:null, logs:null, multiResized:false };
  let loadedLayoutZone   = null;
  let selectionMaskStyleEl = null;
  let answerUserResized  = false;
  let answerUserMoved    = false;
  let lastPointer         = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY };
  let qmThemeSettings     = null;  // cached settings for theme application
  let chatHistoryPersistenceFailed = false;

  /* ═══ SETTINGS CACHE ═══════════════════════════════════════════════ */
  const DEF_HK = { screenshot:'Ctrl+Shift+U', yandexQuestion:'Ctrl+Shift+H', resetWindows:'Ctrl+Shift+R', toggleExtension:'Ctrl+Shift+L', logs:'Alt+L' };
  let cachedHK            = { ...DEF_HK };
  let cachedModels        = [];
  let multiCheckEnabled   = false;
  let screenshotTemperature    = 0;
  let screenshotMaxTokens      = 500;
  let currentScreenshotTaskId  = null; /* tracks active screenshot task; stale multicheck results are discarded */
  let gptChatLoaderActive   = false;
  let chatFilePickerActive  = false;
  let currentModel          = '';
  let lastSettingsModel     = '';
  let defaultTextModel      = '';
  let quizScanEnabled       = false;
  let quizAutoApplyEnabled  = false;
  let quizShowAnswerWidget  = true;
  let lastDetectedQuestion  = null;
  let lastQuestionSource    = 'none';

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }


  function getRuntimeIconUrl(basePath, fileName) {
    if (!basePath || !fileName) return '';
    return (globalThis.chrome?.runtime?.getURL?.(`${basePath}/${fileName}`)) || '';
  }

  function getWidgetIconUrl(fileName) {
    return getRuntimeIconUrl(WIDGET_ICON_BASE, fileName);
  }

  function getWindowIconUrl(fileName) {
    return getRuntimeIconUrl(WINDOW_ICON_BASE, fileName);
  }

  async function loadWidgetIconSvg(fileName) {
    if (!fileName) return '';
    if (widgetIconSvgCache.has(fileName)) return widgetIconSvgCache.get(fileName);
    const iconUrl = getWidgetIconUrl(fileName);
    if (!iconUrl) return '';
    try {
      const res = await fetch(iconUrl);
      if (!res.ok) return '';
      const svgText = await res.text();
      if (!svgText.includes('<svg')) return '';
      widgetIconSvgCache.set(fileName, svgText);
      return svgText;
    } catch {
      return '';
    }
  }

  async function replaceBrokenWidgetIcon(img, fileName, alt) {
    const svgText = await loadWidgetIconSvg(fileName);
    if (!svgText || !img?.parentNode) return;
    const fallback = document.createElement('span');
    fallback.className = `${img.className} qm-icon--inline`;
    fallback.setAttribute('role', 'img');
    if (alt) fallback.setAttribute('aria-label', alt);
    else fallback.setAttribute('aria-hidden', 'true');
    fallback.innerHTML = svgText;
    img.replaceWith(fallback);
  }

  async function loadWindowIconSvg(fileName) {
    if (!fileName) return '';
    if (windowIconSvgCache.has(fileName)) return windowIconSvgCache.get(fileName);
    const iconUrl = getWindowIconUrl(fileName);
    if (!iconUrl) return '';
    try {
      const res = await fetch(iconUrl);
      if (!res.ok) return '';
      const svgText = await res.text();
      if (!svgText.includes('<svg')) return '';
      windowIconSvgCache.set(fileName, svgText);
      return svgText;
    } catch {
      return '';
    }
  }

  async function replaceBrokenWindowIcon(img, fileName, alt) {
    const svgText = await loadWindowIconSvg(fileName);
    if (!svgText || !img?.parentNode) return;
    const fallback = document.createElement('span');
    fallback.className = `${img.className} qm-window-icon--inline`;
    fallback.setAttribute('role', 'img');
    if (alt) fallback.setAttribute('aria-label', alt);
    else fallback.setAttribute('aria-hidden', 'true');
    fallback.innerHTML = svgText;
    img.replaceWith(fallback);
  }

  function createIcon({ fileName, alt = '', className = 'qm-icon' } = {}) {
    const img = document.createElement('img');
    img.className = className;
    img.alt = alt;
    img.decoding = 'async';
    img.loading = 'eager';
    img.src = getWidgetIconUrl(fileName);
    img.addEventListener('error', () => {
      replaceBrokenWidgetIcon(img, fileName, alt);
    }, { once: true });
    return img;
  }

  function createWindowIcon({ fileName, alt = '', className = 'qm-window-icon' } = {}) {
    const img = document.createElement('img');
    img.className = className;
    img.alt = alt;
    img.decoding = 'async';
    img.loading = 'eager';
    img.src = getWindowIconUrl(fileName);
    img.addEventListener('error', () => {
      replaceBrokenWindowIcon(img, fileName, alt);
    }, { once: true });
    return img;
  }

  function setWindowButtonIcon(button, { fileName, alt = '', className = 'qm-window-icon qm-window-icon--control' } = {}) {
    if (!button) return;
    button.replaceChildren(createWindowIcon({ fileName, alt, className }));
  }

  const WINDOW_DEFAULTS = {
    answer:  { width: 340, height: 120, minW: 60,  minH: 28,  maxH: 540  },
    history: { width: 340, height: 300, minW: 240, minH: 200, maxH: null },
    chat:    { width: 340, height: 340, minW: 260, minH: 220, maxH: null },
    multi:   { width: 200, height:  60, minW:  80, minH:  28, maxH: null },
    logs:    { width: 900, height: 420, minW: 600, minH: 300, maxH: null },
  };

  function getWindowConfig(type) { return WINDOW_DEFAULTS[type] || WINDOW_DEFAULTS.answer; }

  function sanitizeRect(rect, type = 'answer') {
    if (!rect || typeof rect !== 'object') return null;
    const cfg = getWindowConfig(type);
    const fallbackW = cfg.width, fallbackH = cfg.height;
    const minW = cfg.minW || 160, minH = cfg.minH || 36;
    const maxHByViewport = window.innerHeight - 8;
    const maxHByType = cfg.maxH ? Math.min(cfg.maxH, maxHByViewport) : maxHByViewport;
    const rawW = Number(rect.width), rawH = Number(rect.height);
    const rawX = Number(rect.x),    rawY = Number(rect.y);
    const w = clamp(Number.isFinite(rawW) && rawW > 0 ? rawW : fallbackW, minW, window.innerWidth - 8);
    const h = clamp(Number.isFinite(rawH) && rawH > 0 ? rawH : fallbackH, minH, maxHByType);
    const x = clamp(Number.isFinite(rawX) ? rawX : 20, 0, Math.max(0, window.innerWidth  - w));
    const y = clamp(Number.isFinite(rawY) ? rawY : 20, 0, Math.max(0, window.innerHeight - h));
    return { x, y, width: w, height: h };
  }

  function sanitizeStoredRect(rect, type = 'answer') {
    if (!rect || typeof rect !== 'object') return null;
    const hasPos  = Number.isFinite(Number(rect.x)) && Number.isFinite(Number(rect.y));
    const hasSize = Number.isFinite(Number(rect.width)) && Number.isFinite(Number(rect.height));
    if (!hasPos || !hasSize) return null;
    if (Number(rect.width) <= 40 || Number(rect.height) <= 40) return null;
    if (Number(rect.x) <= 2 && Number(rect.y) <= 2) return null;
    return sanitizeRect(rect, type);
  }

  function resolveActiveZone() {
    return (activeZone === 'left' || widgetSide === 'left') ? 'left' : 'right';
  }

  function isAnswerRectAtZoneBottom(rect, zone = resolveActiveZone()) {
    if (!rect) return false;
    const edgeGap = zone === 'left'
      ? Number(rect.x)
      : window.innerWidth - (Number(rect.x) + Number(rect.width));
    const bottomGap = window.innerHeight - (Number(rect.y) + Number(rect.height));
    return Math.abs(edgeGap) <= 24 && Math.abs(bottomGap) <= 24;
  }

  function isAnswerDefaultLayoutMode() {
    return !answerUserMoved && !answerUserResized && !windowLayoutState.answerCustomized;
  }

  function getDefaultRect(type) {
    const margin = 20;
    const base   = getWindowConfig(type);
    const width  = clamp(base.width, base.minW || 160, window.innerWidth - 8);
    const baseMaxH = base.maxH ? Math.min(base.maxH, window.innerHeight - 8) : window.innerHeight - 8;
    const height = clamp(base.height, base.minH || 36, baseMaxH);
    const zone   = resolveActiveZone();
    const x = zone === 'left' ? margin : Math.max(margin, window.innerWidth - width - margin);
    const y = Math.max(margin, window.innerHeight - height - margin);
    return { x, y, width, height };
  }

  async function loadWindowLayoutState() {
    try {
      const d = await safeStorageLocalGet(
        [WINDOW_STATE_KEY, WINDOW_STATE_ZONE_KEY, WINDOW_KEYS.answer, WINDOW_KEYS.history, WINDOW_KEYS.chat, WINDOW_KEYS.multi, WINDOW_KEYS.logs], {}
      );
      const raw = d?.[WINDOW_STATE_KEY] || {};
      loadedLayoutZone = ['left','right'].includes(d?.[WINDOW_STATE_ZONE_KEY]) ? d[WINDOW_STATE_ZONE_KEY] : null;
      const storedAnswerRect = sanitizeStoredRect(d?.[WINDOW_KEYS.answer] || raw.answer, 'answer');
      const answerCustomized = Boolean(storedAnswerRect) && (
        Boolean(raw.answerCustomized)
        || !isAnswerRectAtZoneBottom(storedAnswerRect, loadedLayoutZone || 'right')
      );
      windowLayoutState = {
        answer:      answerCustomized ? storedAnswerRect : null,
        answerCustomized,
        history:     sanitizeStoredRect(d?.[WINDOW_KEYS.history] || raw.history, 'history'),
        chat:        sanitizeStoredRect(d?.[WINDOW_KEYS.chat]    || raw.chat,    'chat'),
        multi:       sanitizeStoredRect(d?.[WINDOW_KEYS.multi]   || raw.multi,   'multi'),
        logs:        sanitizeStoredRect(d?.[WINDOW_KEYS.logs]    || raw.logs,    'logs'),
        // multiResized survives reload so fitToContent knows not to auto-size after user resize
        multiResized: Boolean(raw.multiResized),
      };
    } catch {
      loadedLayoutZone  = null;
      windowLayoutState = { answer:null, answerCustomized:false, history:null, chat:null, multi:null, logs:null, multiResized:false };
    }
  }

  let layoutSaveTimer = null;
  function saveWindowLayoutState() {
    clearTimeout(layoutSaveTimer);
    layoutSaveTimer = setTimeout(() => {
      safeStorageLocalSet({
        [WINDOW_STATE_KEY]:      windowLayoutState,
        [WINDOW_STATE_ZONE_KEY]: widgetSide,
        [WINDOW_KEYS.answer]:    windowLayoutState.answer,
        [WINDOW_KEYS.history]:   windowLayoutState.history,
        [WINDOW_KEYS.chat]:      windowLayoutState.chat,
        [WINDOW_KEYS.multi]:     windowLayoutState.multi,
        [WINDOW_KEYS.logs]:      windowLayoutState.logs,
      });
    }, 120);
  }

  function sanitizeHistoryEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const answer = String(entry.answer || '').trim();
    if (!answer) return null;
    return {
      query:  String(entry.query  || '').trim(),
      answer,
      model:  String(entry.model  || '').trim(),
      ts:     Number.isFinite(Number(entry.ts)) ? Number(entry.ts) : Date.now(),
    };
  }

  async function loadAnswerHistory() {
    try {
      const data = await safeStorageLocalGet([HISTORY_STORAGE_KEY], {});
      const raw  = Array.isArray(data?.[HISTORY_STORAGE_KEY]) ? data[HISTORY_STORAGE_KEY] : [];
      const normalized = raw.map(sanitizeHistoryEntry).filter(Boolean).slice(-HISTORY_MAX);
      ansHistory.splice(0, ansHistory.length, ...normalized);
    } catch { ansHistory.splice(0, ansHistory.length); }
  }

  function saveAnswerHistory() {
    return safeStorageLocalSet({ [HISTORY_STORAGE_KEY]: ansHistory.slice(-HISTORY_MAX) });
  }

  function estimateChatImageBytes(dataUrl) {
    const value = String(dataUrl || '');
    const comma = value.indexOf(',');
    if (comma < 0) return 0;
    const payloadLength = Math.max(0, value.length - comma - 1);
    return Math.floor(payloadLength * 0.75);
  }

  function getChatFilenameExtension(filename) {
    const match = String(filename || '').trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/);
    return match?.[1] || '';
  }

  function sanitizeChatFilename(filename) {
    const leaf = String(filename || '').split(/[\\/]/).pop() || '';
    return leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
  }

  function getChatAttachmentDescriptor(file) {
    const filename = sanitizeChatFilename(file?.name || file?.filename);
    const extension = getChatFilenameExtension(filename);
    const reportedMime = String(file?.type || file?.mimeType || '').trim().toLowerCase();
    if (reportedMime && !CHAT_ALLOWED_ATTACHMENT_MIME_TYPES.has(reportedMime)) return null;
    const fileMime = CHAT_NON_IMAGE_FILE_MIME_BY_EXTENSION[extension];
    const imageMime = CHAT_IMAGE_MIME_BY_EXTENSION[extension];
    if (fileMime) return { kind:'file', filename, extension, mimeType:fileMime };
    if (imageMime) return { kind:'image', filename, extension, mimeType:imageMime };
    return null;
  }

  function estimateBase64DataUrlBytes(dataUrl) {
    const value = String(dataUrl || '');
    const comma = value.indexOf(',');
    if (comma < 0) return 0;
    const payload = value.slice(comma + 1).replace(/=+$/, '');
    return Math.floor(payload.length * 0.75);
  }

  function sanitizeChatFile(file) {
    if (!file || typeof file !== 'object') return null;
    const descriptor = getChatAttachmentDescriptor(file);
    if (!descriptor || descriptor.kind !== 'file') return null;
    const normalized = {
      kind:'file',
      filename:descriptor.filename,
      extension:descriptor.extension,
      mimeType:descriptor.mimeType,
      bytes:Math.max(0, Math.min(MAX_CHAT_FILE_BYTES, Math.floor(Number(file.bytes) || 0))),
      ts:Number.isFinite(Number(file.ts)) ? Number(file.ts) : Date.now(),
    };
    const dataUrl = String(file.dataUrl || '');
    if (dataUrl) {
      const match = dataUrl.match(/^data:([^;,]+);base64,/i);
      const dataMime = String(match?.[1] || '').toLowerCase();
      const estimatedBytes = estimateBase64DataUrlBytes(dataUrl);
      if (!match || dataMime !== descriptor.mimeType || dataUrl.length > MAX_CHAT_FILE_DATA_URL_CHARS || estimatedBytes < 1 || estimatedBytes > MAX_CHAT_FILE_BYTES) return null;
      normalized.dataUrl = dataUrl;
      normalized.bytes = Math.max(1, Math.min(MAX_CHAT_FILE_BYTES, Math.floor(Number(file.bytes) || estimatedBytes)));
    } else if (file.dataPruned === true) {
      normalized.dataPruned = true;
    } else {
      return null;
    }
    return normalized;
  }

  function chatFilesIncludePdf(files) {
    return (Array.isArray(files) ? files : []).some(file => (
      String(file?.extension || '').toLowerCase() === 'pdf'
      || String(file?.mimeType || '').toLowerCase() === 'application/pdf'
    ));
  }

  function looksLikePdfParseFailure(answer) {
    const text = String(answer || '').trim();
    return Boolean(text) && CHAT_PDF_PARSE_FAILURE_PATTERNS.some(pattern => pattern.test(text));
  }

  function sanitizeChatImage(image) {
    if (!image || typeof image !== 'object') return null;
    const dataUrl = String(image.dataUrl || '');
    const match = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,/i);
    if (!match || dataUrl.length > MAX_CHAT_IMAGE_DATA_URL_CHARS) return null;
    const width = Math.max(1, Math.min(MAX_CHAT_IMAGE_SIDE, Math.floor(Number(image.width) || 1)));
    const height = Math.max(1, Math.min(MAX_CHAT_IMAGE_SIDE, Math.floor(Number(image.height) || 1)));
    const mimeType = match[1].toLowerCase().replace('jpg', 'jpeg');
    const normalized = {
      dataUrl,
      mimeType: `image/${mimeType}`,
      width,
      height,
      bytes: Math.min(MAX_CHAT_IMAGE_BYTES, Math.max(1, Math.floor(Number(image.bytes) || estimateChatImageBytes(dataUrl)))),
    };
    const name = String(image.name || '').trim().slice(0, 120);
    if (name) normalized.name = name;
    return normalized;
  }

  function enforceChatHistoryImageBudget(history) {
    const output = history.map(message => ({
      ...message,
      ...(Array.isArray(message.images) ? { images: [...message.images] } : {}),
    }));
    let imageChars = output.reduce((sum, message) => sum + (message.images || []).reduce((n, image) => n + image.dataUrl.length, 0), 0);

    for (let i = 0; i < output.length - 1 && imageChars > MAX_CHAT_HISTORY_IMAGE_CHARS; i += 1) {
      if (!output[i].images?.length) continue;
      imageChars -= output[i].images.reduce((sum, image) => sum + image.dataUrl.length, 0);
      delete output[i].images;
      if (!output[i].content) { output.splice(i, 1); i -= 1; }
    }

    while (output.length > 1 && imageChars > MAX_CHAT_HISTORY_IMAGE_CHARS) {
      const removed = output.shift();
      imageChars -= (removed?.images || []).reduce((sum, image) => sum + image.dataUrl.length, 0);
    }
    return output;
  }

  function pruneChatFileData(file) {
    const { dataUrl, ...metadata } = file;
    return { ...metadata, dataPruned:true };
  }

  function enforceChatHistoryFileBudget(history) {
    const output = history.map(message => ({
      ...message,
      ...(Array.isArray(message.files) ? { files:message.files.map(file => ({ ...file })) } : {}),
    }));
    let fileBytes = output.reduce((sum, message) => sum + (message.files || []).reduce((n, file) => n + (file.dataUrl ? estimateBase64DataUrlBytes(file.dataUrl) : 0), 0), 0);
    for (let i = 0; i < output.length - 1 && fileBytes > CHAT_HISTORY_FILE_DATA_BUDGET_BYTES; i += 1) {
      for (let j = 0; j < (output[i].files || []).length && fileBytes > CHAT_HISTORY_FILE_DATA_BUDGET_BYTES; j += 1) {
        const file = output[i].files[j];
        if (!file.dataUrl) continue;
        fileBytes -= estimateBase64DataUrlBytes(file.dataUrl);
        output[i].files[j] = pruneChatFileData(file);
      }
    }
    return output;
  }

  function pruneOldestPersistedChatFile(history) {
    const output = history.map(message => ({
      ...message,
      ...(Array.isArray(message.files) ? { files:message.files.map(file => ({ ...file })) } : {}),
    }));
    for (let i = 0; i < output.length - 1; i += 1) {
      const fileIndex = (output[i].files || []).findIndex(file => Boolean(file.dataUrl));
      if (fileIndex < 0) continue;
      output[i].files[fileIndex] = pruneChatFileData(output[i].files[fileIndex]);
      return output;
    }
    return null;
  }

  function sanitizeChatMessage(message) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) return null;
    const content = String(message.content ?? message.text ?? '').trim().slice(0, CHAT_MESSAGE_MAX_CHARS);
    const images = message.role === 'user'
      ? (Array.isArray(message.images) ? message.images : []).map(sanitizeChatImage).filter(Boolean).slice(0, MAX_PENDING_CHAT_IMAGES)
      : [];
    const files = message.role === 'user' && !images.length
      ? (Array.isArray(message.files) ? message.files : []).map(sanitizeChatFile).filter(Boolean).slice(0, MAX_PENDING_CHAT_FILES)
      : [];
    if (!content && !images.length && !files.length) return null;
    const normalized = {
      role: message.role,
      content,
      ts: Number.isFinite(Number(message.ts)) ? Number(message.ts) : Date.now(),
    };
    if (images.length) normalized.images = images;
    if (files.length) normalized.files = files;
    if (message.role === 'assistant') {
      const model = String(message.model || '').trim().slice(0, 200);
      if (model) normalized.model = model;
    }
    return normalized;
  }

  function normalizeChatHistory(history) {
    const normalized = (Array.isArray(history) ? history : [])
      .map(sanitizeChatMessage)
      .filter(Boolean)
      .slice(-CHAT_HISTORY_STORE_LIMIT);
    return enforceChatHistoryFileBudget(enforceChatHistoryImageBudget(normalized));
  }

  async function loadChatHistory() {
    const data = await safeStorageLocalGet([CHAT_HISTORY_KEY], {});
    return normalizeChatHistory(data?.[CHAT_HISTORY_KEY]);
  }

  async function saveChatHistory(history) {
    const normalized = normalizeChatHistory(history);
    if (!runtimeOk()) return normalized;
    let candidate = normalized;
    while (candidate.length) {
      try {
        await chrome.storage.local.set({ [CHAT_HISTORY_KEY]: candidate });
        chatHistoryPersistenceFailed = false;
        return candidate;
      } catch (error) {
        if (ctxErr(error)) { isDestroyed = true; break; }
        const prunedFiles = pruneOldestPersistedChatFile(candidate);
        if (prunedFiles) { candidate = prunedFiles; continue; }
        if (candidate.length === 1) break;
        candidate = candidate.slice(1);
      }
    }
    chatHistoryPersistenceFailed = true;
    return normalized;
  }

  function appendChatHistory(history, message) {
    return saveChatHistory([...(Array.isArray(history) ? history : []), message]);
  }

  async function clearChatHistory() {
    await safeStorageLocalRemove([CHAT_HISTORY_KEY]);
    chatHistoryPersistenceFailed = false;
  }

  function getChatContactSheetInstruction(content) {
    return /[а-яё]/i.test(String(content || ''))
      ? CHAT_CONTACT_SHEET_INSTRUCTION_RU
      : CHAT_CONTACT_SHEET_INSTRUCTION_EN;
  }

  function getChatContactSheetCacheKey(images) {
    return images.map(image => `${image.dataUrl.length}:${image.bytes}:${image.dataUrl.slice(-24)}`).join('|');
  }

  async function getChatContextForRequest(history) {
    const messages = normalizeChatHistory(history).slice(-CHAT_HISTORY_SEND_LIMIT);
    const requestMessages = [];
    for (const [index, { role, content, images, files }] of messages.entries()) {
      if (role === 'user' && files?.length) {
        const availableFiles = files.filter(file => Boolean(file.dataUrl));
        if (!availableFiles.length) {
          if (!content && index === messages.length - 1) throw new Error(ct('widget.chat_file_data_unavailable'));
          if (content) requestMessages.push({ role, content });
          continue;
        }
        requestMessages.push({
          role,
          content:[
            { type:'text', text:content || ct('widget.chat_file_default_prompt') },
            ...availableFiles.map(file => ({ type:'file', file:{ filename:file.filename, file_data:file.dataUrl } })),
          ],
        });
        continue;
      }
      if (role !== 'user' || !images?.length) {
        requestMessages.push({ role, content });
        continue;
      }

      let requestImages = images;
      let requestText = content || CHAT_IMAGE_DEFAULT_PROMPT;
      if (images.length > 1) {
        const contactSheet = await createChatContactSheet(images);
        requestImages = [contactSheet];
        requestText = `${requestText}\n\n${getChatContactSheetInstruction(content)}`;
      }
      requestMessages.push({
        role,
        content: [
          { type:'text', text:requestText },
          ...requestImages.map(image => ({ type:'image_url', image_url:{ url:image.dataUrl } })),
        ],
      });
    }
    return requestMessages;
  }

  function injectCourseContextIntoChatMessages(messages, courseContext) {
    if (!courseContext || !Array.isArray(messages)) return messages;
    const output = messages.map(message => ({
      ...message,
      ...(Array.isArray(message.content) ? { content:message.content.map(part => ({ ...part })) } : {}),
    }));
    let userIndex = -1;
    for (let index = output.length - 1; index >= 0; index -= 1) {
      if (output[index]?.role === 'user') { userIndex = index; break; }
    }
    if (userIndex < 0) return output;
    const message = output[userIndex];
    const existingTextChars = Array.isArray(message.content)
      ? message.content.reduce((sum, part) => sum + (part?.type === 'text' ? String(part.text || '').length : 0), 0)
      : String(message.content || '').length;
    const marker = '\n\nCURRENT USER MESSAGE:\n';
    const availableContextChars = Math.max(0, 20_000 - existingTextChars - marker.length);
    if (availableContextChars < 500) return output;
    const boundedContext = courseContext.slice(0, availableContextChars);
    if (Array.isArray(message.content)) {
      message.content.unshift({ type:'text', text:`${boundedContext}${marker}` });
    } else {
      message.content = `${boundedContext}${marker}${String(message.content || '')}`;
    }
    return output;
  }

  function injectCourseContextIntoYandexText(questionText, courseContext) {
    return courseContext ? `${courseContext}\n\nCURRENT YANDEX FORMS QUESTION:\n${questionText}` : questionText;
  }

  async function getCoursePackRequestContext(queryText, surface) {
    const api = globalThis.TACoursePack;
    if (!api) return { context:'', chunks:[], pack:null, enabled:false };
    try {
      const result = await api.getCourseContext(queryText, surface);
      if (result.enabled) {
        const meta = {
          surface,
          courseId:String(result.pack?.courseId || '').slice(0, 160),
          queryChars:String(queryText || '').length,
          chunkIds:result.chunks.map(chunk => chunk.id).slice(0, 8),
          pages:result.chunks.map(chunk => chunk.page).slice(0, 8),
        };
        qmLog('FLOW', 'Course Pack retrieval', meta);
        void sendLog('Course Pack retrieval', meta);
      }
      return result;
    } catch (error) {
      qmLog('ERROR', 'Course Pack retrieval failed', { surface, reason:String(error?.code || error?.message || 'unknown').slice(0, 80) });
      return { context:'', chunks:[], pack:null, enabled:false };
    }
  }

  function readChatBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Unable to read image.'));
      reader.readAsDataURL(blob);
    });
  }

  function chatCanvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Unable to optimize image.'));
      }, type, quality);
    });
  }

  async function exportChatContactSheet(canvas) {
    let workingCanvas = canvas;
    let quality = 0.8;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const blob = await chatCanvasToBlob(workingCanvas, 'image/jpeg', quality);
      if (blob.size <= CHAT_CONTACT_SHEET_MAX_BYTES) {
        const dataUrl = await readChatBlobAsDataUrl(blob);
        if (dataUrl.length <= CHAT_CONTACT_SHEET_MAX_DATA_URL_CHARS) {
          return { dataUrl, mimeType:'image/jpeg', width:workingCanvas.width, height:workingCanvas.height, bytes:blob.size };
        }
      }
      if (quality > 0.58) {
        quality = Math.max(0.58, quality - 0.07);
        continue;
      }
      const scaled = document.createElement('canvas');
      scaled.width = Math.max(640, Math.round(workingCanvas.width * 0.82));
      scaled.height = Math.max(360, Math.round(workingCanvas.height * 0.82));
      const context = scaled.getContext('2d', { alpha:false });
      if (!context) break;
      context.drawImage(workingCanvas, 0, 0, scaled.width, scaled.height);
      workingCanvas = scaled;
      quality = 0.72;
    }
    throw new Error(ct('widget.chat_contact_sheet_failed'));
  }

  async function createChatContactSheet(images) {
    const safeImages = (Array.isArray(images) ? images : []).map(sanitizeChatImage).filter(Boolean).slice(0, MAX_PENDING_CHAT_IMAGES);
    if (safeImages.length < 2) return safeImages[0] || null;
    const cacheKey = getChatContactSheetCacheKey(safeImages);
    const cached = chatContactSheetCache.get(cacheKey);
    if (cached) return cached;

    const bitmaps = [];
    try {
      for (const image of safeImages) {
        const response = await fetch(image.dataUrl);
        if (!response.ok) throw new Error(ct('widget.chat_contact_sheet_failed'));
        bitmaps.push(await createImageBitmap(await response.blob()));
      }

      const columns = 2;
      const rows = Math.ceil(bitmaps.length / columns);
      const padding = 24;
      const gap = 20;
      const labelHeight = 38;
      const cellWidth = Math.floor((CHAT_CONTACT_SHEET_MAX_SIDE - (padding * 2) - gap) / columns);
      const imageHeight = 560;
      const cellHeight = labelHeight + imageHeight;
      const canvas = document.createElement('canvas');
      canvas.width = CHAT_CONTACT_SHEET_MAX_SIDE;
      canvas.height = (padding * 2) + (rows * cellHeight) + ((rows - 1) * gap);
      const context = canvas.getContext('2d', { alpha:false });
      if (!context) throw new Error(ct('widget.chat_contact_sheet_failed'));
      context.fillStyle = '#f8fafc';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.font = '600 24px Inter, Arial, sans-serif';
      context.textBaseline = 'middle';

      bitmaps.forEach((bitmap, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = padding + (column * (cellWidth + gap));
        const y = padding + (row * (cellHeight + gap));
        context.fillStyle = '#ffffff';
        context.fillRect(x, y, cellWidth, cellHeight);
        context.strokeStyle = '#cbd5e1';
        context.lineWidth = 2;
        context.strokeRect(x + 1, y + 1, cellWidth - 2, cellHeight - 2);
        context.fillStyle = '#0f172a';
        context.fillText(`Image ${index + 1}`, x + 16, y + (labelHeight / 2));

        const availableWidth = cellWidth - 24;
        const availableHeight = imageHeight - 20;
        const scale = Math.min(availableWidth / bitmap.width, availableHeight / bitmap.height);
        const drawWidth = Math.max(1, Math.round(bitmap.width * scale));
        const drawHeight = Math.max(1, Math.round(bitmap.height * scale));
        const drawX = x + Math.round((cellWidth - drawWidth) / 2);
        const drawY = y + labelHeight + Math.round((imageHeight - drawHeight) / 2);
        context.drawImage(bitmap, drawX, drawY, drawWidth, drawHeight);
      });

      const contactSheet = await exportChatContactSheet(canvas);
      chatContactSheetCache.set(cacheKey, contactSheet);
      if (chatContactSheetCache.size > 20) chatContactSheetCache.delete(chatContactSheetCache.keys().next().value);
      return contactSheet;
    } finally {
      bitmaps.forEach(bitmap => { try { bitmap.close?.(); } catch {} });
    }
  }

  async function optimizeChatImageFile(file) {
    if (!(file instanceof Blob) || !/^image\/(png|jpe?g|webp)$/i.test(String(file.type || ''))) {
      throw new Error('Unsupported image type.');
    }

    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file);
      let targetSide = MAX_CHAT_IMAGE_SIDE;
      let quality = 0.82;
      let best = null;

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const scale = Math.min(1, targetSide / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Unable to optimize image.');
        context.drawImage(bitmap, 0, 0, width, height);
        const blob = await chatCanvasToBlob(canvas, 'image/jpeg', quality);
        if (!best || blob.size < best.blob.size) best = { blob, width, height };
        if (blob.size <= MAX_CHAT_IMAGE_BYTES) {
          const dataUrl = await readChatBlobAsDataUrl(blob);
          if (dataUrl.length > MAX_CHAT_IMAGE_DATA_URL_CHARS) throw new Error('Image is too large.');
          return {
            dataUrl,
            mimeType: 'image/jpeg',
            width,
            height,
            bytes: blob.size,
            name: String(file.name || 'screenshot.jpg').slice(0, 120),
          };
        }
        if (quality > 0.58) quality = Math.max(0.58, quality - 0.08);
        else { targetSide = Math.max(640, Math.round(targetSide * 0.8)); quality = 0.74; }
      }

      if (best?.blob && best.blob.size <= MAX_CHAT_IMAGE_BYTES) {
        const dataUrl = await readChatBlobAsDataUrl(best.blob);
        return { dataUrl, mimeType:'image/jpeg', width:best.width, height:best.height, bytes:best.blob.size, name:String(file.name || 'screenshot.jpg').slice(0, 120) };
      }
    } catch (error) {
      if (file.size > MAX_CHAT_IMAGE_BYTES) throw error;
    } finally {
      try { bitmap?.close?.(); } catch {}
    }

    if (file.size > MAX_CHAT_IMAGE_BYTES) throw new Error('Image is too large.');
    const dataUrl = await readChatBlobAsDataUrl(file);
    const image = sanitizeChatImage({ dataUrl, mimeType:file.type, width:1, height:1, bytes:file.size, name:file.name });
    if (!image) throw new Error('Image is too large.');
    return image;
  }

  function pushAnswerHistory(entry) {
    const safe = sanitizeHistoryEntry(entry);
    if (!safe) return;
    ansHistory.push(safe);
    if (ansHistory.length > HISTORY_MAX) ansHistory.splice(0, ansHistory.length - HISTORY_MAX);
    saveAnswerHistory();
  }

  function applyRect(el, rect, defaults = {}) {
    if (!el || !rect) return;
    const minHeight = defaults.minHeight || 60;
    el.style.left      = `${rect.x}px`;
    el.style.top       = `${rect.y}px`;
    el.style.right     = 'auto';
    el.style.bottom    = 'auto';
    el.style.transform = 'none';
    el.style.width     = `${rect.width  || defaults.width  || 360}px`;
    el.style.height    = `${rect.height || defaults.height || 320}px`;
    el.style.minHeight = `${minHeight}px`;
    el.style.maxWidth  = `calc(100vw - 8px)`;
    el.style.maxHeight = `calc(100vh - 8px)`;
  }

  /* ═══ FIX A+D: applyAnswerFrame — restores both position AND size from saved rect ═══ */
  function applyAnswerFrame(el, rect, defaults = {}) {
    if (!el || !rect) return;
    const zone      = resolveActiveZone();
    const savedRect = isAnswerDefaultLayoutMode() ? null : windowLayoutState.answer;
    const hasSavedPos  = savedRect && Number.isFinite(Number(savedRect.x))     && Number.isFinite(Number(savedRect.y));
    const hasSavedSize = savedRect && Number(savedRect.width)  > 40 && Number.isFinite(Number(savedRect.width))
                                   && Number(savedRect.height) > 40 && Number.isFinite(Number(savedRect.height));

    /* Position */
    if (hasSavedPos) {
      el.style.left   = `${savedRect.x}px`;
      el.style.top    = `${savedRect.y}px`;
      el.style.right  = 'auto';
      el.style.bottom = 'auto';
    } else {
      el.style.left   = zone === 'left'  ? `${ANSWER_VIEWPORT_MARGIN}px` : 'auto';
      el.style.right  = zone === 'right' ? `${ANSWER_VIEWPORT_MARGIN}px` : 'auto';
      el.style.bottom = `${ANSWER_VIEWPORT_MARGIN}px`;
      el.style.top    = 'auto';
    }
    el.style.transform = 'none';

    /* Size — restore if user previously resized, otherwise auto */
    if (hasSavedSize) {
      el.style.width     = `${savedRect.width}px`;
      el.style.height    = `${savedRect.height}px`;
      el.style.maxWidth  = 'calc(100vw - 8px)';
      el.style.maxHeight = 'calc(100vh - 8px)';
    } else {
      el.style.width     = 'auto';
      el.style.height    = 'auto';
      el.style.maxWidth  = '';
      el.style.maxHeight = '';
    }
  }

  /* applyFloatingLoaderSide — positions the answer floating loader via LoaderController. */
  function applyFloatingLoaderSide(el) {
    if (!el) return;
    new window.__QM.LoaderController({
      loaderEl:      el,
      getWindowRect: () => windowLayoutState.answer,
      getZone:       () => resolveActiveZone(),
      loaderSize:    46,
      fallback:      null,
    }).place();
  }

  function captureRect(el, type = 'answer') {
    if (!el) return null;
    if (!el.isConnected || el.style.display === 'none') return null;
    const r = el.getBoundingClientRect();
    if (!Number.isFinite(r.width) || !Number.isFinite(r.height) || r.width < 40 || r.height < 30) return null;
    return sanitizeRect({ x: r.left, y: r.top, width: r.width, height: r.height }, type);
  }

  function getWindowRect(type) {
    if (type === 'answer' && isAnswerDefaultLayoutMode()) return getDefaultRect(type);
    return windowLayoutState[type] ? sanitizeRect(windowLayoutState[type], type) : getDefaultRect(type);
  }

  /* ═══ FIX F: persistWindowRect — removed atBottom guard so size is always saved ═══ */
  function persistWindowRect(type, el) {
    const rect = captureRect(el, type);
    if (!rect) return;
    if (rect.x <= 2 && rect.y <= 2) return;
    windowLayoutState[type] = rect;
    saveWindowLayoutState();
  }

  /* ═══ WINDOW MANAGER ═══════════════════════════════════════════════ */
  const WindowManager = (() => {
    const windows = new Map();

    function createWindow(type, cfg = {}) {
      const prev  = windows.get(type) || {};
      const state = {
        type,
        panel:        cfg.panel        || prev.panel        || null,
        initialized:  Boolean(cfg.panel || prev.panel),
        getPinned:    cfg.getPinned    || prev.getPinned    || (() => false),
        startTimer:   cfg.startTimer   || prev.startTimer   || (() => {}),
        stopTimer:    cfg.stopTimer    || prev.stopTimer    || (() => {}),
        persistRect:  cfg.persistRect  || prev.persistRect  || (() => {}),
        updateLayout: cfg.updateLayout || prev.updateLayout || (() => {}),
        restoreRect:  cfg.restoreRect  || prev.restoreRect  || (() => {}),
        _hideTimer:   prev._hideTimer  || null,
      };
      windows.set(type, state);
      return state;
    }

    function getWindow(type)  { return windows.get(type) || null; }
    function getPanel(type)   { return getWindow(type)?.panel || null; }
    function isWindowVisible(type) {
      const p = getPanel(type);
      if (!p || p.style.display === 'none') return false;
      // Treat a panel mid-exit-animation as not visible (prevents re-hiding)
      if (p.classList.contains('qm-panel--hiding')) return false;
      return true;
    }
    function isWindowPinned(type) {
      const w = getWindow(type);
      if (!w) return false;
      try { return Boolean(w.getPinned?.()); } catch { return false; }
    }
    function restoreWindowRect(type) { const w = getWindow(type); if (!w?.panel) return; w.restoreRect?.(); }
    function persistWindowRectSafe(type) { const w = getWindow(type); if (!w?.panel) return; w.persistRect?.(); }
    function updateWindowLayout(type) { const w = getWindow(type); if (!w?.panel) return; w.updateLayout?.(); }

    // Duration of qm-panel-out animation in ms (must match CSS)
    const PANEL_OUT_MS = 220;

    function showWindow(type, options = {}) {
      const w = getWindow(type); if (!w?.panel) return;
      if (options.restore !== false) restoreWindowRect(type);

      // All windows animate — cancel any in-flight hide, then materialize
      if (w._hideTimer) { clearTimeout(w._hideTimer); w._hideTimer = null; }
      w.panel.classList.remove('qm-panel--hiding');
      const wasHidden = w.panel.style.display === 'none' || !w.panel.style.display;
      w.panel.style.display = options.display || 'flex';
      if (wasHidden) {
        w.panel.classList.remove('qm-panel--appearing');
        requestAnimationFrame(() => {
          if (w.panel) w.panel.classList.add('qm-panel--appearing');
        });
      }

      if (options.updateLayout) w.updateLayout?.();
      if (options.startTimer && !isWindowPinned(type)) w.startTimer?.();
      we?.refreshLauncherVisibility?.();
    }

    function hideWindow(type, options = {}) {
      const w = getWindow(type); if (!w?.panel) return;
      if (options.persist !== false) w.persistRect?.();

      // All windows animate — dissolve out, then set display:none
      w.panel.classList.remove('qm-panel--appearing');
      w.panel.classList.add('qm-panel--hiding');
      if (w._hideTimer) clearTimeout(w._hideTimer);
      w._hideTimer = setTimeout(() => {
        if (w.panel) {
          w.panel.style.display = 'none';
          w.panel.classList.remove('qm-panel--hiding');
        }
        w._hideTimer = null;
      }, PANEL_OUT_MS);

      if (options.stopTimer !== false) w.stopTimer?.();
      we?.refreshLauncherVisibility?.();
    }

    function destroyWindow(type) {
      const w = getWindow(type); if (!w) return;
      if (w._hideTimer) { clearTimeout(w._hideTimer); w._hideTimer = null; }
      w.stopTimer?.(); w.panel?.remove?.(); windows.delete(type);
    }

    return {
      createWindow, getWindow, getPanel,
      showWindow, hideWindow, destroyWindow,
      isWindowVisible, isWindowPinned,
      restoreWindowRect,
      persistWindowRect: persistWindowRectSafe,
      updateWindowLayout,
    };
  })();

  /* ── QM Logger from content/qm-logger.js ────────────────────────────── */
  const _QML             = window.__QM_LOGGER;
  const qmLog            = (c, m, d)    => _QML?.qmLog(c, m, d);
  const quizLog          = (s, m, d, l) => _QML?.quizLog(s, m, d, l);
  const qmLogEnabled     = ()           => Boolean(_QML?.qmLogEnabled());
  const qmDownloadLog    = ()           => _QML?.qmDownloadLog() ?? Promise.resolve(false);
  const toggleQmLogPanel  = ()          => _QML?.toggleQmLogPanel();
  const destroyQmLogPanel = ()          => _QML?.destroyQmLogPanel();
  _QML?.init({ safeSendMessage, getWe: () => we, WindowManager });

  /* ── Quiz module context registration ───────────────────────────────
   * Wire content.js's closure state/functions into the quiz engine.
   * Function declarations are hoisted so this is safe to call here.
   * ────────────────────────────────────────────────────────────────── */
  const QM_QUIZ = window.__QM?.quiz;
  if (QM_QUIZ) {
    QM_QUIZ.init({
      get extensionEnabled()      { return extensionEnabled; },
      get quizScanEnabled()       { return quizScanEnabled; },
      get quizAutoApplyEnabled()  { return quizAutoApplyEnabled; },
      get quizShowAnswerWidget()  { return quizShowAnswerWidget; },
      get defaultTextModel()      { return defaultTextModel; },
      get currentModel()          { return currentModel; },
      get lastSettingsModel()     { return lastSettingsModel; },
      addManagedListener,
      safeSendMessage,
      showAnswer,
      requestVisualAnswer: requestYandexVisualAnswer,
      getWidgetElements: () => we,
      qmLog,
      runtimeOk,
      isDebugEnabled: () => qmLogEnabled(),
    });
  }

  async function refreshCache() {
    try {
      if (!window.TASettingsStorage) return;
      const s = await window.TASettingsStorage.getSettings();
      _QML?.setEnabled?.(Boolean(s.save_logs));
      cachedHK = {
        screenshot:      s.custom_hotkey_screenshot       || DEF_HK.screenshot,
        yandexQuestion:   s.custom_hotkey_yandex_question || DEF_HK.yandexQuestion,
        resetWindows:    s.custom_hotkey_reset_windows    || DEF_HK.resetWindows,
        toggleExtension: s.custom_hotkey_toggle_extension || DEF_HK.toggleExtension,
        logs:            s.custom_hotkey_logs             || DEF_HK.logs,
      };
      const ms = Number(s.widget_timer_ms);
      if (ms >= 1000 && ms <= 60_000) WIDGET_TIMER_MS = ms;
      cachedModels      = Array.isArray(s.multi_check_models) ? s.multi_check_models : [];
      multiCheckEnabled = Boolean(s.multi_check_enabled);
      screenshotTemperature = Number.isFinite(Number(s.screenshot_temperature))
        ? Math.max(0, Math.min(1, Number(s.screenshot_temperature))) : 0;
      screenshotMaxTokens = Number.isFinite(Number(s.screenshot_max_tokens))
        ? Math.max(32, Math.min(2048, Math.floor(Number(s.screenshot_max_tokens)))) : 500;
      defaultTextModel = String(s.model_text || '').trim();
      const preferred = s.widget_current_model || s.model_text || s.model_vision || '';
      const shouldSyncCurrent = !currentModel || currentModel === lastSettingsModel || Boolean(s.widget_current_model);
      if (preferred && shouldSyncCurrent) currentModel = preferred;
      lastSettingsModel = preferred;
      const yandexAutomationAllowed = isYandexFormsPage();
      quizScanEnabled = Boolean(s.quiz_page_scan_enabled && yandexAutomationAllowed);
      quizAutoApplyEnabled = Boolean(s.quiz_auto_apply_enabled && yandexAutomationAllowed);
      quizShowAnswerWidget = s.quiz_show_answer_widget !== false;
      QM_QUIZ?.ensureQuizScanObserver(quizScanEnabled);
      QM_QUIZ?.attachQuizHoverTracking();
      if (quizScanEnabled && extensionEnabled) QM_QUIZ?.scheduleQuizPrefetch();
      if (we) {
        syncModelSelect(s);
        if (we.timerText) we.timerText.textContent = Math.round(WIDGET_TIMER_MS / 1000) + ct('popup.seconds_abbr');
        const zone = s.active_zone || s.widget_position || 'right';
        // Zone-based layout reset removed — custom positions are preserved across zone changes.
        if (loadedLayoutZone && loadedLayoutZone !== zone) loadedLayoutZone = zone;
        else if (!loadedLayoutZone) loadedLayoutZone = zone;
        if (zone !== widgetSide) applyWidgetSide(zone);
        we.syncChatFromSettings?.(s);
        // Gate logs FAB and panel on save_logs — mirrors initWidgetFromStorage so the
        // button appears/disappears immediately when the setting is toggled, without reload.
        if (we.logsFab) {
          const logsEnabled = Boolean(s.save_logs);
          we.logsFab.style.display = logsEnabled ? 'inline-flex' : 'none';
          if (!logsEnabled) {
            WindowManager.hideWindow('logs', { persist:false, stopTimer:true });
            _QML?.clearCallbacks();
          }
        }
      }
      if (settingsEl?.togEls) {
        for (const [k, btn] of Object.entries(settingsEl.togEls)) {
          btn.dataset.on = String(Boolean(s[k]));
        }
      }
      if (settingsEl?.screenshotTempInput)  settingsEl.screenshotTempInput.value  = String(screenshotTemperature);
      if (settingsEl?.screenshotTokensInput) settingsEl.screenshotTokensInput.value = String(screenshotMaxTokens);
      if (settingsEl?.zoneBtn) settingsEl.zoneBtn.textContent = (s.active_zone || 'right') === 'left' ? '⬅ Left' : '➡ Right';
      qmThemeSettings = s;
      qmReapplyAllThemes();
    } catch {}
  }

  function teardownAllUiForDisable() {
    hideActionButton();
    cleanupSS();
    timerStop();
    WindowManager.hideWindow('answer',  { persist: false, stopTimer: true });
    WindowManager.hideWindow('history', { persist: true,  stopTimer: true });
    WindowManager.hideWindow('chat',    { persist: true,  stopTimer: true });
    WindowManager.hideWindow('multi',   { persist: true,  stopTimer: true });
    if (we?.edgeWrap) { we.edgeWrap.style.opacity = '0'; we.edgeWrap.style.pointerEvents = 'none'; we.edgeWrap.style.display = 'none'; }
    if (settingsEl?.pop) { settingsEl.pop.style.display = 'none'; settingsVisible = false; }
  }

  function applySelectionMask() {
    if (!extensionEnabled) {
      selectionMaskStyleEl?.remove();
      selectionMaskStyleEl = null;
      return;
    }
    if (selectionMaskStyleEl) return;
    const st = document.createElement('style');
    st.id = 'quizmind-selection-mask';
    st.textContent = `
      ::selection { background: transparent !important; color: inherit !important; }
      ::-moz-selection { background: transparent !important; color: inherit !important; }
    `;
    (document.head || document.documentElement).appendChild(st);
    selectionMaskStyleEl = st;
  }

  async function refreshExtensionEnabled() {
    try {
      const d = await safeStorageLocalGet(['extension_enabled'], {});
      extensionEnabled = d.extension_enabled !== false;
      applySelectionMask();
      if (!extensionEnabled) { teardownAllUiForDisable(); return; }
      ensureWidget();
      initWidgetFromStorage();
      if (quizScanEnabled) QM_QUIZ?.scheduleQuizPrefetch();
      if (actionButton) actionButton.style.display = 'none';
    } catch { extensionEnabled = true; applySelectionMask(); }
  }

  if (chrome?.storage?.onChanged) {
    addManagedChromeListener(chrome.storage.onChanged, (ch, area) => {
      if (area !== 'local') return;
      if (ch.taSettings) refreshCache();
      if (Object.prototype.hasOwnProperty.call(ch, 'extension_enabled')) refreshExtensionEnabled();
    });
  }

  /* ═══ THEME HELPERS ════════════════════════════════════════════════ */

  /**
   * Apply stored theme settings to a specific shadow root.
   * Uses TAThemeEngine if available; silently skips if not loaded yet.
   */
  function qmApplyThemeTo(shadowRoot, surface) {
    try {
      const eng = globalThis.TAThemeEngine;
      if (!eng || !shadowRoot) return;
      eng.applyFromSettings(qmThemeSettings, surface, shadowRoot);
    } catch {}
  }

  /**
   * Apply Chameleon mode to a shadow root.
   * Detects page colors at (x,y) and applies an adaptive theme.
   * Called once when a window opens — not continuously.
   */
  function qmApplyChameleonTo(shadowRoot, surface, x, y) {
    try {
      const eng = globalThis.TAThemeEngine;
      if (!eng || !shadowRoot || !qmThemeSettings) return;
      if (!qmThemeSettings.chameleon_enabled) return;
      const scope = qmThemeSettings.chameleon_scope || 'widget_inpage';
      // Only apply to popup/settings if scope is 'all'
      if (scope !== 'all' && (surface === 'popup' || surface === 'settings')) return;
      const strength = qmThemeSettings.chameleon_strength || 'medium';
      const vars = eng.detectChameleon(x, y, strength);
      if (vars) {
        eng.applyToShadowRoot(shadowRoot, vars);
        // Also push to document :root so actionButton (outside shadow DOM) follows Chameleon
        if (surface === 'widget') eng.applyToDocumentRoot(vars);
      }
    } catch {}
  }

  /**
   * Re-apply themes to all currently created shadow roots.
   * Called when settings change.
   */
  function qmReapplyAllThemes() {
    try {
      if (shadowHost?.shadowRoot) qmApplyThemeTo(shadowHost.shadowRoot, 'widget');
      if (multiHost?.shadowRoot)  qmApplyThemeTo(multiHost.shadowRoot,  'inpage');
      if (settingsHost?.shadowRoot) qmApplyThemeTo(settingsHost.shadowRoot, 'settings');
      // Also inject theme vars into document :root for elements outside shadow DOM
      const eng = globalThis.TAThemeEngine;
      if (eng && qmThemeSettings?.theme_enabled) {
        const presetName = qmThemeSettings.theme_global_preset || 'default';
        const customOverrides = qmThemeSettings.theme_global_custom || {};
        const vars = eng.generateVars(presetName, customOverrides);
        eng.applyToDocumentRoot(vars);
      } else if (eng) {
        eng.removeFromDocumentRoot();
      }
    } catch {}
  }

  let layoutStateReady = loadWindowLayoutState();
  let settingsReady    = refreshCache();
  refreshExtensionEnabled();

  /* ═══ HOTKEY MATCHING ══════════════════════════════════════════════ */
  function matchHotkey(e, str) {
    return Boolean(globalThis.__QM?.hotkeys?.match?.(e, str));
  }

  /* ═══ SELECTION / ACTION BUTTON ═══════════════════════════════════ */
  function clearHighlights() { selHighlights.forEach(m => m.remove()); selHighlights = []; }

  function snapshotSelection(selection = window.getSelection()) {
    const snapshot = globalThis.__QM?.yandexForms?.createSelectionSnapshot?.(selection, {
      minLength:WIDGET_MIN_SEL,
      url:location.href,
    }) || null;
    if (!snapshot) return null;
    qmLog('FLOW', 'Selection snapshot created', {
      selectedChars:snapshot.selectedText.length,
      hasQuestion:Boolean(snapshot.question),
      urlPath:location.pathname,
    });
    return snapshot;
  }

  function getEndpointRect(range, edge = 'start') {
    const probe   = range.cloneRange();
    const isStart = edge === 'start';
    const container = isStart ? range.startContainer : range.endContainer;
    const offset    = isStart ? range.startOffset    : range.endOffset;
    if (container.nodeType === Node.TEXT_NODE) {
      const len  = container.textContent?.length || 0;
      if (!len) return null;
      const safe = Math.min(Math.max(offset, 0), len);
      const from = isStart ? safe : Math.max(0, safe - 1);
      const to   = Math.min(len, from + 1);
      if (from >= to) return null;
      probe.setStart(container, from);
      probe.setEnd(container, to);
    } else {
      const childCount = container.childNodes?.length || 0;
      if (!childCount) return null;
      const idx   = isStart ? Math.min(offset, childCount - 1) : Math.max(0, Math.min(offset - 1, childCount - 1));
      const child = container.childNodes[idx];
      if (!child) return null;
      probe.selectNodeContents(child);
      probe.collapse(isStart);
      if (child.nodeType === Node.TEXT_NODE && (child.textContent?.length || 0) > 0) {
        const p = child.textContent.length;
        probe.setStart(child, isStart ? 0 : Math.max(0, p - 1));
        probe.setEnd(child, isStart ? 1 : p);
      }
    }
    const rect = [...probe.getClientRects()].find(r => r.width > 0 && r.height > 0) || probe.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return rect;
  }

  function renderSelectionEndpoints(range) {
    clearHighlights();
    const sRect = getEndpointRect(range, 'start');
    const eRect = getEndpointRect(range, 'end');
    [sRect, eRect].forEach(rect => {
      if (!rect) return;
      const m = document.createElement('div');
      m.className = 'ta-helper-endpoint-highlight';
      Object.assign(m.style, {
        position:'absolute', zIndex:'2147483647', pointerEvents:'none',
        background:'rgba(37,99,235,.28)', border:'1px solid rgba(37,99,235,.6)', borderRadius:'4px',
        left:`${window.scrollX + rect.left}px`, top:`${window.scrollY + rect.top}px`,
        width:`${Math.max(2, rect.width)}px`, height:`${Math.max(12, rect.height)}px`,
      });
      document.documentElement.appendChild(m);
      selHighlights.push(m);
    });
  }

  function showActionButton() {
    if (!extensionEnabled) { hideActionButton(); return; }
    if (!actionButton) {
      actionButton = document.createElement('button');
      actionButton.className  = 'ta-helper-selection-button';
      actionButton.type = 'button';
      actionButton.dataset.quizmindUi = 'selection-find';
      Object.assign(actionButton.style, { position:'absolute', zIndex:'2147483647', display:'none', alignItems:'center', justifyContent:'center', border:'1px solid var(--qm-accent,#93c5fd)', background:'var(--qm-accent,#3b82f6)', color:'var(--qm-surface,#ffffff)', borderRadius:'var(--qm-radius,10px)', padding:'7px 12px', font:'600 12px Inter,sans-serif', boxShadow:'var(--qm-shadow,0 6px 20px rgba(15,23,42,.25))', cursor:'pointer' });
      actionButton.addEventListener('mousedown', e => { if (e.isTrusted) e.preventDefault(); });
      actionButton.addEventListener('click', async (event) => {
        if (!event.isTrusted) return;
        const captured = selectionSnapshot;
        hideActionButton({ preserveSnapshot:true });
        await runAnswerFlow('button', 'answer', { selectionSnapshot:captured });
      });
      document.documentElement.appendChild(actionButton);
    }
    actionButton.textContent = globalThis.TAi18n?.t('widget.find') ?? 'Find';
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideActionButton(); return; }
    const range = sel.getRangeAt(0);
    if ((sel.toString() || '').trim().length < WIDGET_MIN_SEL) { hideActionButton(); return; }
    selectionSnapshot = snapshotSelection(sel);
    if (!selectionSnapshot) { hideActionButton(); return; }
    renderSelectionEndpoints(range);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { hideActionButton(); return; }
    actionButton.style.top  = `${window.scrollY + rect.bottom + 8}px`;
    actionButton.style.left = `${window.scrollX + rect.left}px`;
    actionButton.style.display = 'inline-flex';
  }

  function hideActionButton({ preserveSnapshot = false } = {}) {
    clearHighlights();
    if (actionButton) actionButton.style.display = 'none';
    if (!preserveSnapshot) selectionSnapshot = null;
  }

  /* ═══ QUESTION TEXT ════════════════════════════════════════════════
   * Quiz state, constants, and engine functions are in content/qm-quiz.js.
   * QM.quiz.init() wires this IIFE's state/functions into the module.
   * ═════════════════════════════════════════════════════════════════ */

  /* ── Quiz engine functions moved to content/qm-quiz.js ── */
  /* All functions from normalizeQuizText through attachQuizHoverTracking */
  /* are now in the self-contained quiz module with dependency injection. */

  function isYandexFormsPage() {
    return Boolean(window.__QM?.yandexForms?.isYandexFormsPage(location, document));
  }

  function waitForYandexLayout() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function getYandexScreenshotRect(questionRoot) {
    const target = questionRoot?.getBoundingClientRect ? questionRoot : null;
    const rect = target?.getBoundingClientRect?.();
    if (!rect) return null;
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right - left < 2 || bottom - top < 2) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function hideQuizMindUiForCapture() {
    const restores = [];
    const nodes = [actionButton, shadowHost, multiHost, settingsHost].filter(Boolean);
    for (const node of nodes) {
      const previous = node.getAttribute('style');
      node.style.setProperty('visibility', 'hidden', 'important');
      restores.push(() => previous === null ? node.removeAttribute('style') : node.setAttribute('style', previous));
    }

    return () => {
      for (let index = restores.length - 1; index >= 0; index -= 1) {
        try { restores[index](); } catch {}
      }
    };
  }

  async function waitForYandexQuestionImages(questionRoot, timeoutMs = 1500) {
    const pending = [...(questionRoot?.querySelectorAll?.('img.QuestionLayout-Image,img.OptionContent-Image') || [])]
      .filter((image) => !image.complete);
    if (!pending.length) return;
    await Promise.race([
      Promise.allSettled(pending.map((image) => new Promise((resolve) => {
        image.addEventListener('load', resolve, { once:true });
        image.addEventListener('error', resolve, { once:true });
      }))),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async function captureYandexQuestionScreenshot(question, { signal, allowScroll = true } = {}) {
    const questionRoot = question?.container;
    if (!questionRoot?.isConnected) throw new Error('Yandex Forms question is no longer available.');
    if (allowScroll) {
      questionRoot.scrollIntoView({ block:'center', inline:'nearest' });
      await waitForYandexLayout();
    }
    await waitForYandexQuestionImages(questionRoot);
    if (signal?.aborted) return null;
    const rect = getYandexScreenshotRect(questionRoot);
    if (!rect) throw new Error('Yandex Forms question is outside the visible viewport.');
    const restore = hideQuizMindUiForCapture();
    try {
      await waitForYandexLayout();
      const capture = await safeSendMessage({
        type:'CAPTURE_YANDEX_QUESTION',
        payload:{ rect, viewport:collectViewport() },
      });
      if (signal?.aborted) return null;
      if (!capture?.ok || !capture.dataUrl) throw new Error(capture?.error || 'Yandex Forms question capture failed.');
      return capture.dataUrl;
    } finally {
      restore();
    }
  }

  async function requestYandexVisualAnswer(question, { silent = false, allowScroll = true, signal } = {}) {
    if (!question?.hasVisual) return { ok:false, error:'Question has no visual content.' };
    try {
      if (!silent) showLoading();
      const structured = String(QM_QUIZ?.buildStructuredPrompt(question) || '').slice(0, YANDEX_QUESTION_MAX_CHARS);
      const course = await getCoursePackRequestContext(`${question.type}\n${question.prompt}`, 'yandex');
      const questionText = injectCourseContextIntoYandexText(structured, course.context);
      const dataUrl = await captureYandexQuestionScreenshot(question, { signal, allowScroll });
      if (!dataUrl) return { ok:false, error:'Capture canceled.' };
      return safeSendMessage({
        type:'GET_YANDEX_SCREENSHOT_ANSWER',
        payload:{ questionText, questionType:question.type, dataUrl },
      });
    } catch (error) {
      qmLog('FLOW', 'Yandex visual question failed', { reason:String(error?.message || 'capture_failed').slice(0, 100) });
      return { ok:false, error:error?.message || 'Yandex Forms visual answer failed.' };
    }
  }

  function getQuestionText(capturedSelection = null) {
    /* Bridge: calls into quiz module for DOM extraction; content.js owns lastDetectedQuestion */
    lastDetectedQuestion = null;
    QM_QUIZ?.ensureQuizScanObserver(quizScanEnabled);

    const validSnapshot = capturedSelection && capturedSelection.url === location.href
      && capturedSelection.selectedText?.length >= WIDGET_MIN_SEL;
    const sel = validSnapshot ? null : window.getSelection();
    const liveSnapshot = validSnapshot ? capturedSelection : snapshotSelection(sel);
    const txt = String(liveSnapshot?.selectedText || '').trim();
    if (txt.length >= WIDGET_MIN_SEL) {
      try {
        const inContainer = liveSnapshot.questionRoot?.isConnected
          ? liveSnapshot.questionRoot
          : QM_QUIZ?.getNearestQuestionContainer(liveSnapshot.range?.commonAncestorContainer);
        if (inContainer) {
          const q = QM_QUIZ?.extractQuestionData(inContainer) || liveSnapshot.question;
          if (q) {
            lastDetectedQuestion = q;
            lastQuestionSource = 'yandex_question';
            return QM_QUIZ?.buildStructuredPrompt(q) ?? '';
          }
        }
        const parts = [];
        if (liveSnapshot.before) parts.push(`[context before]: ${liveSnapshot.before}`);
        parts.push(`[question]: ${txt}`);
        if (liveSnapshot.after) parts.push(`[context after]: ${liveSnapshot.after}`);
        lastQuestionSource = 'selection';
        return parts.join('\n');
      } catch { /* selection extraction failed — fall through */ }
      lastQuestionSource = 'selection';
      return txt;
    }

    if (QM_QUIZ && isYandexFormsPage()) {
      const q = QM_QUIZ.findBestQuestionFromSelection?.();
      if (q) {
        lastDetectedQuestion = q;
        lastQuestionSource = 'yandex_question';
        return QM_QUIZ.buildStructuredPrompt(q) ?? '';
      }
    }
    lastQuestionSource = 'none';
    return '';
  }

  /* ═══ VIEWPORT ═════════════════════════════════════════════════════ */
  function collectViewport() {
    const vv = window.visualViewport;
    return {
      innerWidth:               Math.max(1, Math.floor(window.innerWidth  || 0)),
      innerHeight:              Math.max(1, Math.floor(window.innerHeight || 0)),
      visualViewportWidth:      Math.max(1, Math.floor(vv?.width  || window.innerWidth  || 1)),
      visualViewportHeight:     Math.max(1, Math.floor(vv?.height || window.innerHeight || 1)),
      visualViewportOffsetLeft: Number(vv?.offsetLeft || 0),
      visualViewportOffsetTop:  Number(vv?.offsetTop  || 0),
      devicePixelRatio:         Number(window.devicePixelRatio || 1),
      scrollX:                  Number(window.scrollX || 0),
      scrollY:                  Number(window.scrollY || 0),
    };
  }

  /* ═══ SCREENSHOT SELECTION ════════════════════════════════════════ */
  function cleanupSS() {
    if (!screenshotSess) return;
    screenshotSess.overlay.remove();
    window.removeEventListener('keydown', screenshotSess.kd, true);
    screenshotSess = null;
  }

  function startManualScreenshotSelection() {
    cleanupSS();
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      Object.assign(overlay.style, { position:'fixed', inset:'0', zIndex:'2147483647', cursor:'crosshair', background:'transparent' });
      const box = document.createElement('div');
      Object.assign(box.style, { position:'absolute', border:'2px solid #2563eb', background:'transparent', display:'none', boxSizing:'border-box', pointerEvents:'none' });
      overlay.appendChild(box);
      document.documentElement.appendChild(overlay);
      let sx = 0, sy = 0, drag = false;
      const upd = (cx, cy) => {
        const x = Math.min(sx, cx), y = Math.min(sy, cy), w = Math.abs(cx - sx), h = Math.abs(cy - sy);
        Object.assign(box.style, { display:'block', left:`${x}px`, top:`${y}px`, width:`${w}px`, height:`${h}px` });
      };
      const fin = (roi) => { cleanupSS(); resolve(roi); };
      overlay.addEventListener('mousedown', e => { e.preventDefault(); drag = true; sx = e.clientX; sy = e.clientY; upd(sx, sy); });
      overlay.addEventListener('mousemove', e => { if (drag) upd(e.clientX, e.clientY); });
      overlay.addEventListener('mouseup',   e => {
        if (!drag) return;
        drag = false;
        const x = Math.floor(Math.min(sx, e.clientX)), y = Math.floor(Math.min(sy, e.clientY));
        const w = Math.floor(Math.abs(e.clientX - sx)), h = Math.floor(Math.abs(e.clientY - sy));
        fin(w < 4 || h < 4 ? null : { x, y, width: w, height: h });
      });
      const kd = e => { if (e.key === 'Escape') { e.preventDefault(); fin(null); } };
      addManagedListener(window, 'keydown', kd, true);
      screenshotSess = { overlay, kd };
    });
  }

  /* ═══ TIMER (answer window) — backed by TimerController from qm-shared.js ══
   *
   * answerTimer is created in ensureWidget() once the widget DOM exists.
   * Public functions below are thin wrappers so existing call sites in
   * teardownAllUiForDisable(), showLoading(), ensureWidget() event handlers,
   * destroy(), and the WindowManager registration all remain unchanged.
   * ═══════════════════════════════════════════════════════════════════════ */

  function updateWidgetTimerBar(ratio) {
    if (!we?.tbar) return;
    we.tbar.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
  }

  function applyWidgetPinnedState() {
    if (!we?.tbar) return;
    we.tbar.style.display = widgetPinned ? 'none' : 'block';
    if (!widgetPinned) updateWidgetTimerBar(1);
    if (we.pinBtn) {
      we.pinBtn.dataset.on = String(widgetPinned);
      setWindowButtonIcon(we.pinBtn, { fileName: widgetPinned ? WINDOW_ICONS.keepOff : WINDOW_ICONS.keep, alt: widgetPinned ? ct('widget.unpin_window') : ct('widget.pin_window') });
      we.pinBtn.title = widgetPinned ? ct('widget.unpin_window') : ct('widget.pin_window');
    }
  }

  /** Stop the answer timer countdown. */
  function timerStop()    { answerTimer?.stop(); }

  /**
   * Start (or restart) the answer countdown for `ms` milliseconds.
   * Also updates WIDGET_TIMER_MS so the rest of the UI (timer text, multi) stays in sync.
   */
  function timerStart(ms) {
    if (ms !== undefined) WIDGET_TIMER_MS = ms;
    applyWidgetPinnedState();
    answerTimer?.start(WIDGET_TIMER_MS);
  }

  /** Pause the countdown (call on mouseenter — saves remaining time). */
  function timerPause()   { answerTimer?.pause(); }

  /** Resume from saved remaining time (call on mouseleave). */
  function timerResume()  { answerTimer?.resume(); }

  function toggleWidgetPin() {
    widgetPinned = !widgetPinned;
    applyWidgetPinnedState();
    if (widgetPinned) { timerStop(); return; }
    timerStart(WIDGET_TIMER_MS);
  }

  /* ═══ WIDGET POSITION ══════════════════════════════════════════════ */
  function applyWidgetSide(side) {
    const normalized = side === 'left' ? 'left' : 'right';
    const changed    = widgetSide !== normalized;
    widgetSide       = normalized;
    activeZone       = normalized;
    if (!we?.widget) return;
    // Zone change no longer resets custom window positions.
    // If the user wants defaults, they use the reset button (Ctrl+Shift+R).
    applyDefaultRect(we.widget, 'answer');
    if (we.historyPanel?.panel) applyPanelLayoutOrDefault('history', we.historyPanel.panel, { width: getWindowConfig('history').width, height: getWindowConfig('history').height });
    if (we.chatPanel?.panel)    applyPanelLayoutOrDefault('chat',    we.chatPanel.panel,    { width: getWindowConfig('chat').width,    height: getWindowConfig('chat').height    });
    if (we.logsPanel?.panel)    applyPanelLayoutOrDefault('logs',    we.logsPanel.panel,    { width: getWindowConfig('logs').width,    height: getWindowConfig('logs').height    });
    if (me?.panel)              applyPanelLayoutOrDefault('multi',   me.panel,              { width: getWindowConfig('multi').width,   height: getWindowConfig('multi').height   });
    we.widget.style.transform = 'none';
    if (we.rowLbl) we.rowLbl.textContent = normalized === 'left' ? '⬅ Left' : '➡ Right';
    window.TASettingsStorage?.setSettings({ active_zone: normalized, widget_position: normalized }).catch(() => {});
    we?.setZone?.(normalized);
    if (we?.widget?.style?.display && we.widget.style.display !== 'none') updateAnswerLayout();
  }

  /* ═══ MODEL SELECT HELPERS ═════════════════════════════════════════ */
  function shortName(m) { return String(m || '').split('/').pop() || m; }

  function syncModelSelect(s) {
    if (!we?.modelSel) return;
    const sel  = we.modelSel;
    const models = [...new Set([
      s.model_text || '', s.model_vision || '',
      ...(Array.isArray(s.multi_check_models) ? s.multi_check_models : []),
    ].filter(Boolean))];
    sel.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m; o.textContent = shortName(m); sel.appendChild(o);
    }
    sel.value = currentModel || s.widget_current_model || s.model_text || s.model_vision || '';
    if (!sel.value && sel.options[0]) sel.value = sel.options[0].value;
    currentModel = sel.value;
  }

  async function initWidgetFromStorage() {
    try {
      // Load language before creating any UI
      if (globalThis.TAi18n) await globalThis.TAi18n.loadLanguage();
      if (!window.TASettingsStorage) return;
      const s = await window.TASettingsStorage.getSettings();
      if (!currentModel) currentModel = s.widget_current_model || s.model_text || 'openai/gpt-5.3-chat';
      cachedModels      = Array.isArray(s.multi_check_models) ? s.multi_check_models : [];
      multiCheckEnabled = Boolean(s.multi_check_enabled);
      await loadAnswerHistory();
      if (we) {
        syncModelSelect(s);
        if (!we.modelSel.value) { we.modelSel.value = currentModel || 'openai/gpt-5.3-chat'; currentModel = we.modelSel.value; }
        WIDGET_TIMER_MS = Number(s.widget_timer_ms) || 5000;
        if (we.timerText) we.timerText.textContent = Math.round(WIDGET_TIMER_MS / 1000) + ct('popup.seconds_abbr');
        applyWidgetSide(s.active_zone || s.widget_position || 'right');
        we.syncChatFromSettings?.(s);
        // Gate logs FAB and panel on save_logs setting
        if (we.logsFab) {
          const logsEnabled = Boolean(s.save_logs);
          we.logsFab.style.display = logsEnabled ? 'inline-flex' : 'none';
          if (!logsEnabled) {
            WindowManager.hideWindow('logs', { persist:false, stopTimer:true });
            _QML?.clearCallbacks();
          }
        }
      }
    } catch {}
  }

  /* ═══ LAYOUT HELPERS ═══════════════════════════════════════════════ */
  function applyDefaultRect(el, type) {
    if (!el) return;
    const cfg  = getWindowConfig(type);
    const rect = getWindowRect(type);
    if (type === 'answer') {
      applyAnswerFrame(el, { x: rect.x, y: rect.y, width: rect.width }, { width: rect.width || cfg.width });
      el.style.height    = 'auto';
      el.style.minHeight = '0';
      el.style.maxHeight = '100vh';
      return;
    }
    applyRect(el, rect, { width: rect.width, height: rect.height, minHeight: cfg.minH || 60 });
    el.style.maxHeight = 'calc(100vh - 8px)';
  }

  function resolvePanelRect(key) {
    if (key === 'answer') return null;
    const raw = windowLayoutState[key];
    if (!raw) return null;
    const safe = sanitizeRect(raw, key);
    windowLayoutState[key] = safe;
    return safe;
  }

  function applyPanelLayoutOrDefault(key, el, defaults) {
    const cfg  = getWindowConfig(key);
    const rect = resolvePanelRect(key) || getWindowRect(key);
    if (key === 'answer') {
      applyAnswerFrame(el, { x: rect.x, y: rect.y, width: rect.width }, { width: defaults.width || rect.width || cfg.width });
      el.style.height = 'auto'; el.style.minHeight = '0'; el.style.maxHeight = '100vh';
      return;
    }
    applyRect(el, rect, { width: defaults.width || rect.width, height: defaults.height || rect.height, minHeight: cfg.minH || 60 });
  }

  /* ═══ MAIN WIDGET ══════════════════════════════════════════════════ */
  function ensureWidget() {
    if (we) return we;

    shadowHost = document.createElement('div');
    shadowHost.className = 'ta-helper-shadow-host';
    shadowHost.setAttribute('data-quizmind-ui', 'widget');
    document.documentElement.appendChild(shadowHost);
    const sr = shadowHost.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    /* ═══ FIX E: border-radius increased to 24px for fully rounded corners ═══ */
    style.textContent = `
    :host,*{box-sizing:border-box;margin:0;padding:0;}
    @keyframes qm-in{from{opacity:0;transform:translateY(8px) scale(0.97);}to{opacity:1;transform:translateY(0) scale(1);}}
    @keyframes qm-pop{0%{transform:scale(0.88);opacity:0;}60%{transform:scale(1.04);opacity:1;}100%{transform:scale(1);}}
    @keyframes spin{to{transform:rotate(360deg);}}
    @keyframes qm-shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}
    @keyframes qm-panel-in{from{opacity:0;transform:scale(0.94) translateY(14px);}to{opacity:1;transform:scale(1) translateY(0);}}
    @keyframes qm-panel-out{from{opacity:1;transform:scale(1) translateY(0);}to{opacity:0;transform:scale(0.96) translateY(8px);}}
    .qm-panel--appearing{animation:qm-panel-in 0.26s cubic-bezier(0.22,1,0.36,1) both !important;}
    .qm-panel--hiding{animation:qm-panel-out 0.20s cubic-bezier(0.4,0,0.8,0.4) both !important;pointer-events:none !important;}
    @media(prefers-reduced-motion:reduce){.qm-panel--appearing,.qm-panel--hiding{animation:none !important;}.qm-panel--hiding{opacity:0 !important;}}
    .answer-window{
      position:fixed;right:0;bottom:0;left:auto;top:auto;transform:none;
      width:auto;min-width:0;max-width:90vw;
      height:auto;max-height:80vh;min-height:0;
      background:var(--qm-surface,linear-gradient(165deg,rgba(255,255,255,0.72),rgba(241,245,252,0.58)));
      color:var(--qm-text,#0f172a);border-radius:var(--qm-radius,24px);
      box-shadow:var(--qm-shadow,0 20px 52px rgba(15,23,42,0.22)),0 1px 0 rgba(255,255,255,0.72) inset;
      border:1px solid var(--qm-border,rgba(255,255,255,0.72));
      backdrop-filter:blur(var(--qm-blur,18px)) saturate(1.18);
      -webkit-backdrop-filter:blur(var(--qm-blur,18px)) saturate(1.18);
      font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;
      z-index:2147483647;display:none;overflow:visible;user-select:none;resize:none;
      flex-direction:column;
      transition:box-shadow 0.28s cubic-bezier(0.22,1,0.36,1),border-color 0.28s cubic-bezier(0.22,1,0.36,1),transform 0.28s cubic-bezier(0.22,1,0.36,1);
    }
    .answer-window:hover{
      box-shadow:var(--qm-shadow,0 26px 60px rgba(15,23,42,0.26)),0 1px 0 rgba(255,255,255,0.78) inset;
      border-color:rgba(191,219,254,0.82);
      transform:translateY(-2px);
    }
    /* HEADER */
    .hdr{
      display:flex;align-items:center;gap:6px;padding:8px 10px;
      background:var(--qm-header-bg,linear-gradient(180deg,rgba(255,255,255,0.72) 0%,rgba(248,251,255,0.54) 100%));
      border-bottom:1px solid var(--qm-border,rgba(226,232,240,0.62));cursor:grab;min-height:0;
      border-radius:var(--qm-radius,24px) var(--qm-radius,24px) 0 0;
    }
    .hdr:active{cursor:grabbing;}
    .hdr-icon{font-size:14px;flex-shrink:0;}
    .hdr-title{font-size:11px;font-weight:700;color:var(--qm-text,#0f172a);white-space:nowrap;letter-spacing:-0.01em;}
    .model-sel{display:none;flex:1;min-width:0;border:1px solid var(--qm-border,rgba(203,213,225,0.65));border-radius:7px;background:var(--qm-input-bg,rgba(255,255,255,0.88));color:var(--qm-text-2,#334155);font-size:10px;font-family:inherit;padding:2px 5px;height:22px;cursor:pointer;-webkit-appearance:none;appearance:none;outline:none;transition:border-color .18s ease,box-shadow .18s ease;}
    .model-sel:focus{border-color:var(--qm-accent,#2563eb);box-shadow:0 0 0 2px rgba(37,99,235,0.16);}
    .hdr-close{border:1px solid var(--qm-border,rgba(203,213,225,0.6));background:var(--qm-surface-2,rgba(255,255,255,0.68));cursor:pointer;width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:var(--qm-muted,#94a3b8);border-radius:6px;flex-shrink:0;padding:0;transition:background .18s ease,border-color .18s ease,transform .18s cubic-bezier(0.34,1.26,0.64,1),box-shadow .18s ease;}
    .qm-window-icon{object-fit:contain;display:block;pointer-events:none;filter:var(--qm-icon-filter,none);}
    .qm-window-icon--inline{filter:var(--qm-icon-filter,none);}
    .qm-window-icon--inline svg{width:100%;height:100%;display:block;}
    .qm-window-icon--control{width:16px;height:16px;min-width:16px;min-height:16px;}
    .qm-window-icon--fab{width:20px;height:20px;min-width:20px;min-height:20px;}
    .hdr-close:hover{background:var(--qm-accent-light,rgba(239,246,255,0.92));border-color:rgba(147,197,253,0.75);color:var(--qm-accent,#2563eb);transform:translateY(-1px) scale(1.06);box-shadow:0 3px 8px rgba(37,99,235,0.12);}
    .hdr-close:active{transform:translateY(0) scale(0.95);}
    /* NAV */
    .nav{display:none !important;align-items:center;justify-content:space-between;padding:3px 10px;background:var(--qm-header-bg,rgba(248,251,255,0.5));border-bottom:1px solid var(--qm-border,rgba(226,232,240,0.55));font-size:11px;color:var(--qm-muted,#64748b);}
    .nav.vis{display:flex !important;}
    .nav-btn{border:1px solid var(--qm-border,rgba(203,213,225,0.65));background:var(--qm-surface-2,rgba(255,255,255,0.78));border-radius:5px;padding:1px 8px;font-size:11px;cursor:pointer;color:var(--qm-text-2,#334155);font-family:inherit;transition:background .15s ease,transform .15s ease;}
    .nav-btn:hover{background:rgba(255,255,255,0.95);transform:scale(1.04);}.nav-btn:disabled{opacity:.4;cursor:default;}
    /* BODY */
    .body{
      padding:9px 11px;font-size:13px;line-height:1.5;
      overflow-wrap:anywhere;word-break:break-word;
      overflow-y:auto;overflow-x:hidden;user-select:text;
      max-height:480px;
      min-height:0;flex:1 1 auto;width:auto;
    }
    .body::-webkit-scrollbar{width:3px;}.body::-webkit-scrollbar-track{background:transparent;}.body::-webkit-scrollbar-thumb{background:rgba(148,163,184,0.4);border-radius:999px;}.body::-webkit-scrollbar-thumb:hover{background:rgba(148,163,184,0.65);}
    .body p{margin:0 0 6px;}.body p:last-child{margin-bottom:0;}
    .body h1{font-size:15px;font-weight:700;margin:0 0 6px;letter-spacing:-0.02em;}
    .body h2{font-size:14px;font-weight:700;margin:0 0 5px;letter-spacing:-0.01em;}
    .body h3{font-size:13px;font-weight:600;margin:0 0 4px;}
    .body ul,.body ol{margin:0 0 6px;padding-left:18px;}
    .body li{margin-bottom:3px;}
    .body code{font-family:'SF Mono','Fira Code',monospace;font-size:11px;background:var(--qm-surface-2,rgba(241,245,249,0.8));border:1px solid var(--qm-border,rgba(226,232,240,0.7));border-radius:4px;padding:0 4px;}
    .body pre{background:rgba(15,23,42,0.92);color:#e2e8f0;border-radius:10px;padding:10px;overflow-x:auto;margin:6px 0;backdrop-filter:blur(8px);}
    .body pre code{background:none;border:none;padding:0;font-size:11px;color:inherit;}
    .body hr{border:none;border-top:1px solid var(--qm-border,rgba(226,232,240,0.6));margin:6px 0;}
    .body strong{font-weight:700;}.body em{font-style:italic;}
    .body br{display:block;content:'';margin:3px 0;}
    .answer-window--ultra-compact .hdr{padding:5px 9px;}
    .answer-window--ultra-compact .body{padding:4px 9px;line-height:1.15;max-height:120px;}
    .answer-window--ultra-compact .body p{margin:0;}
    .answer-window--ultra-compact .body br{margin:0;}
    .answer-window--ultra-compact .tbar-wrap{height:2px;flex:0 0 2px;}
    .ta-math-b{display:block;text-align:center;font-family:Georgia,serif;font-size:13px;padding:5px 10px;background:var(--qm-surface-2,rgba(248,250,252,0.8));border-radius:8px;border:1px solid var(--qm-border,rgba(226,232,240,0.7));margin:6px 0;}
    .ta-math-i{font-family:Georgia,serif;font-size:11px;background:var(--qm-surface-2,rgba(241,245,249,0.8));border:1px solid var(--qm-border,rgba(226,232,240,0.7));border-radius:4px;padding:0 4px;font-style:italic;}
    /* LOADER */
    .loader{display:none;gap:8px;align-items:center;color:var(--qm-muted,#64748b);font-size:12px;padding:2px 0;}
    .sp{width:14px;height:14px;border:2.5px solid rgba(226,232,240,0.7);border-top-color:var(--qm-accent,#2563eb);border-radius:50%;animation:spin .7s cubic-bezier(0.4,0,0.2,1) infinite;flex-shrink:0;}
    /* TOOLBAR */
    .toolbar{display:none !important;align-items:center;gap:4px;flex-wrap:wrap;justify-content:center;padding:7px 10px;border-top:1px solid var(--qm-border,rgba(226,232,240,0.55));background:var(--qm-header-bg,rgba(248,251,255,0.50));}
    .tb-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--qm-border,rgba(203,213,225,0.65));background:var(--qm-surface-2,rgba(255,255,255,0.72));border-radius:8px;padding:4px 9px;font-size:11px;font-weight:600;font-family:inherit;color:var(--qm-text-2,#334155);cursor:pointer;transition:background .18s ease,border-color .18s ease,transform .18s cubic-bezier(0.34,1.26,0.64,1),box-shadow .18s ease;white-space:nowrap;line-height:1.3;outline:none;}
    .qm-icon{width:16px;height:16px;min-width:16px;min-height:16px;object-fit:contain;display:inline-block;flex-shrink:0;filter:var(--qm-icon-filter,none);}
    .qm-icon--inline{display:inline-flex;align-items:center;justify-content:center;filter:var(--qm-icon-filter,none);}
    .qm-icon--inline svg{width:100%;height:100%;display:block;}
    .qm-icon--timer{width:14px;height:14px;min-width:14px;min-height:14px;}
    .qm-icon--settings{width:16px;height:16px;min-width:16px;min-height:16px;}
    .tb-btn--settings{padding-inline:8px;}
    .tb-btn:hover{background:rgba(255,255,255,0.92);border-color:rgba(148,163,184,0.6);color:var(--qm-text,#0f172a);transform:translateY(-1px);box-shadow:0 3px 8px rgba(15,23,42,0.08);}
    .tb-btn:active{transform:translateY(0);box-shadow:none;}
    .tb-btn.accent{background:var(--qm-accent-light,rgba(239,246,255,0.88));border-color:rgba(191,219,254,0.75);color:var(--qm-accent,#2563eb);}
    .tb-btn.accent:hover{background:rgba(219,234,254,0.95);border-color:rgba(147,197,253,0.8);box-shadow:0 3px 10px rgba(37,99,235,0.14);}
    .t-grp{display:flex;align-items:center;gap:2px;}
    .t-val{display:inline-flex;align-items:center;justify-content:center;gap:5px;font-size:11px;font-weight:700;color:var(--qm-accent,#2563eb);background:var(--qm-accent-light,rgba(239,246,255,0.88));border:1px solid rgba(191,219,254,0.75);border-radius:6px;padding:3px 7px;font-family:'SF Mono','Fira Code',monospace;min-width:32px;text-align:center;}
    /* TIMER BAR */
    .tbar-wrap{height:3px;flex:0 0 3px;width:100%;background:var(--qm-border,rgba(226,232,240,0.55));border-radius:0 0 var(--qm-radius,24px) var(--qm-radius,24px);overflow:hidden;}
    .tbar{height:100%;width:100%;background:linear-gradient(90deg,rgba(147,197,253,0.8),#2563eb,rgba(124,58,237,0.85));transform-origin:left;transform:scaleX(1);}
    /* FLOATING LOADER */
    .fl{position:fixed;bottom:20px;transform:none;width:46px;height:46px;border-radius:999px;display:none;align-items:center;justify-content:center;background:var(--qm-surface,rgba(255,255,255,0.72));border:1px solid var(--qm-border,rgba(255,255,255,0.72));box-shadow:var(--qm-shadow,0 10px 30px rgba(15,23,42,0.2)),0 1px 0 rgba(255,255,255,0.7) inset;backdrop-filter:blur(18px) saturate(1.18);-webkit-backdrop-filter:blur(18px) saturate(1.18);z-index:2147483647;animation:qm-pop 0.25s cubic-bezier(0.34,1.26,0.64,1) both;}
    /* CHAT MODEL PICKER */
    .chat-mdl-list{display:none;max-height:190px;overflow-y:auto;border:1px solid rgba(191,219,254,0.8);border-radius:10px;background:var(--qm-surface,rgba(255,255,255,0.82));width:100%;box-sizing:border-box;box-shadow:0 0 0 2px rgba(37,99,235,0.12),0 10px 28px rgba(37,99,235,0.14);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);animation:qm-in 0.18s ease both;}
    .chat-mdl-item{display:flex;align-items:center;gap:8px;padding:7px 9px;cursor:pointer;border-bottom:1px solid var(--qm-border,rgba(226,232,240,0.55));transition:background .14s ease;}
    .chat-mdl-item:last-child{border-bottom:none;}
    .chat-mdl-item:hover{background:var(--qm-accent-light,rgba(239,246,255,0.9));}
    .chat-mdl-main{flex:1;min-width:0;}
    .chat-mdl-name{font-size:12px;font-weight:600;color:var(--qm-text,#0f172a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .chat-mdl-id{font-size:10px;color:var(--qm-muted,#64748b);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .chat-mdl-star{border:none;background:transparent;font-size:14px;line-height:1;color:var(--qm-muted,#94a3b8);cursor:pointer;padding:0 2px;flex-shrink:0;transition:transform .18s ease,color .18s ease;}
    .chat-mdl-star:hover{transform:scale(1.2);}
    .chat-mdl-star[data-fav=true]{color:#f59e0b;}
    `;

    const widget = document.createElement('div');
    widget.className = 'answer-window answer-window--normal';
    // Set display:none as inline style so isWindowVisible()'s p.style.display check
    // correctly returns false on fresh load.  The CSS class also sets display:none, but
    // WindowManager.isWindowVisible reads inline style only — without this line the answer
    // window is seen as "visible" from the start, which blocks the launcher permanently.
    widget.style.display = 'none';

    const hdr      = document.createElement('div'); hdr.className = 'hdr';
    const hdrIcon  = document.createElement('span'); hdrIcon.className = 'hdr-icon'; hdrIcon.textContent = '🎯'; hdrIcon.style.display = 'none';
    const hdrTitle = document.createElement('div');  hdrTitle.className = 'hdr-title'; hdrTitle.textContent = ct('widget.answer_title'); hdrTitle.style.display = 'none';
    const modelSel = document.createElement('select'); modelSel.className = 'model-sel'; modelSel.title = ct('widget.answer_model'); modelSel.style.display = 'none';
    const hdrPin   = document.createElement('button'); hdrPin.className = 'hdr-close'; hdrPin.type = 'button'; hdrPin.dataset.on='false'; hdrPin.title = ct('widget.pin_window'); setWindowButtonIcon(hdrPin, { fileName: WINDOW_ICONS.keep, alt: ct('widget.pin_window') });
    const hdrClose = document.createElement('button'); hdrClose.className = 'hdr-close'; hdrClose.type = 'button'; setWindowButtonIcon(hdrClose, { fileName: WINDOW_ICONS.close, alt: ct('widget.close_window') });
    hdr.append(hdrIcon, hdrTitle, modelSel, hdrPin, hdrClose);

    const nav     = document.createElement('div');    nav.className = 'nav';
    const prevBtn = document.createElement('button'); prevBtn.className = 'nav-btn'; prevBtn.textContent = '←'; prevBtn.type = 'button';
    const navLbl  = document.createElement('span');
    const nextBtn = document.createElement('button'); nextBtn.className = 'nav-btn'; nextBtn.textContent = '→'; nextBtn.type = 'button';
    nav.append(prevBtn, navLbl, nextBtn);

    const body   = document.createElement('div'); body.className = 'body';
    const loader = document.createElement('div'); loader.className = 'loader';
    loader.innerHTML = `<span class="sp"></span><span>${ct('widget.searching')}</span>`;
    body.append(loader);

    const toolbar   = document.createElement('div'); toolbar.className = 'toolbar';
    const rowBtn    = document.createElement('button'); rowBtn.className = 'tb-btn'; rowBtn.type = 'button';
    const rowIcon   = createIcon({ fileName: WIDGET_ICONS.activityZone, alt: ct('widget.activity_zone'), className: 'qm-icon' });
    const rowLbl    = document.createElement('span'); rowLbl.textContent = '➡ Right';
    rowBtn.append(rowIcon, rowLbl); rowBtn.title = ct('widget.toggle_zone');
    const tGrp    = document.createElement('div'); tGrp.className = 't-grp';
    const tMinus  = document.createElement('button'); tMinus.className = 'tb-btn'; tMinus.type = 'button'; tMinus.textContent = '−'; tMinus.title = ct('widget.less');
    const timerVal = document.createElement('div'); timerVal.className = 't-val';
    const timerIcon = createIcon({ fileName: WIDGET_ICONS.timer, alt: ct('popup.widget_timer'), className: 'qm-icon qm-icon--timer' });
    const timerText = document.createElement('span'); timerText.textContent = '5' + ct('popup.seconds_abbr');
    timerVal.append(timerIcon, timerText);
    const tPlus   = document.createElement('button'); tPlus.className = 'tb-btn'; tPlus.type = 'button'; tPlus.textContent = '+'; tPlus.title = ct('widget.more');
    tGrp.append(tMinus, timerVal, tPlus);
    const multiBtn    = document.createElement('button'); multiBtn.className = 'tb-btn accent'; multiBtn.type = 'button';
    const multiIcon   = createIcon({ fileName: WIDGET_ICONS.multiCheck, alt: 'Multi Check', className: 'qm-icon' });
    const multiText   = document.createElement('span'); multiText.textContent = ct('widget.multi_check');
    multiBtn.append(multiIcon, multiText);
    const settingsBtn = document.createElement('button'); settingsBtn.className = 'tb-btn tb-btn--settings'; settingsBtn.type = 'button'; settingsBtn.title = ct('widget.settings');
    settingsBtn.appendChild(createIcon({ fileName: WIDGET_ICONS.settings, alt: ct('widget.settings'), className: 'qm-icon qm-icon--settings' }));
    settingsBtn.style.marginInline = 'auto';
    toolbar.append(rowBtn, tGrp, multiBtn, settingsBtn);

    const tbarWrap = document.createElement('div'); tbarWrap.className = 'tbar-wrap';
    const tbar     = document.createElement('div'); tbar.className = 'tbar';
    tbarWrap.appendChild(tbar);
    widget.append(hdr, body, tbarWrap);

    const fl = document.createElement('div'); fl.className = 'fl';
    fl.innerHTML = '<span class="sp"></span>';

    sr.append(style, widget, fl);
    qmApplyThemeTo(sr, 'widget');

    /* ── Edge FABs + sub-panels ── */
    const edgeWrap = document.createElement('div');
    Object.assign(edgeWrap.style, { position:'fixed', bottom:'16px', zIndex:'2147483647', display:'flex', gap:'10px', opacity:'0', transform:'scale(0.92)', transition:'opacity .24s ease, transform .24s ease', pointerEvents:'none' });
    const mkFab = ({ iconFileName, alt }) => {
      const b = document.createElement('button'); b.type = 'button';
      Object.assign(b.style, { width:'48px', height:'48px', borderRadius:'999px', border:'1px solid var(--qm-border,rgba(255,255,255,0.72))', background:'var(--qm-surface,rgba(255,255,255,0.72))', boxShadow:'var(--qm-shadow,0 10px 28px rgba(15,23,42,.2)),0 1px 0 rgba(255,255,255,0.70) inset', backdropFilter:'blur(18px) saturate(1.18)', WebkitBackdropFilter:'blur(18px) saturate(1.18)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', padding:'0', transition:'transform 0.2s cubic-bezier(0.34,1.26,0.64,1),box-shadow 0.2s ease,border-color 0.2s ease' });
      b.addEventListener('mouseenter', () => { b.style.transform='translateY(-2px) scale(1.06)'; b.style.boxShadow='0 14px 34px rgba(15,23,42,.26),0 1px 0 rgba(255,255,255,0.78) inset'; b.style.borderColor='rgba(191,219,254,0.82)'; });
      b.addEventListener('mouseleave', () => { b.style.transform=''; b.style.boxShadow='var(--qm-shadow,0 10px 28px rgba(15,23,42,.2)),0 1px 0 rgba(255,255,255,0.70) inset'; b.style.borderColor='var(--qm-border,rgba(255,255,255,0.72))'; });
      b.appendChild(createWindowIcon({ fileName: iconFileName, alt, className: 'qm-window-icon qm-window-icon--fab' }));
      return b;
    };
    const historyFab = mkFab({ iconFileName: WINDOW_ICONS.history, alt: ct('widget.history') });
    const chatFab    = mkFab({ iconFileName: WINDOW_ICONS.chat, alt: ct('widget.chat') });
    const logsFab = (() => {
      const b = document.createElement('button'); b.type = 'button';
      Object.assign(b.style, { width:'48px', height:'48px', borderRadius:'999px', border:'1px solid var(--qm-border,rgba(255,255,255,0.72))', background:'var(--qm-surface,rgba(255,255,255,0.72))', boxShadow:'var(--qm-shadow,0 10px 28px rgba(15,23,42,.2)),0 1px 0 rgba(255,255,255,0.70) inset', backdropFilter:'blur(18px) saturate(1.18)', WebkitBackdropFilter:'blur(18px) saturate(1.18)', cursor:'pointer', display:'none', alignItems:'center', justifyContent:'center', padding:'0', flexShrink:'0', transition:'transform 0.2s cubic-bezier(0.34,1.26,0.64,1),box-shadow 0.2s ease,border-color 0.2s ease' });
      b.addEventListener('mouseenter', () => { b.style.transform='translateY(-2px) scale(1.06)'; b.style.boxShadow='0 14px 34px rgba(15,23,42,.26),0 1px 0 rgba(255,255,255,0.78) inset'; b.style.borderColor='rgba(191,219,254,0.82)'; });
      b.addEventListener('mouseleave', () => { b.style.transform=''; b.style.boxShadow='var(--qm-shadow,0 10px 28px rgba(15,23,42,.2)),0 1px 0 rgba(255,255,255,0.70) inset'; b.style.borderColor='var(--qm-border,rgba(255,255,255,0.72))'; });
      b.addEventListener('mousedown',  () => { b.style.transform='translateY(0px) scale(0.96)'; b.style.boxShadow='0 6px 16px rgba(15,23,42,.18),0 1px 0 rgba(255,255,255,0.60) inset'; });
      b.addEventListener('mouseup',    () => { b.style.transform='translateY(-2px) scale(1.06)'; b.style.boxShadow='0 14px 34px rgba(15,23,42,.26),0 1px 0 rgba(255,255,255,0.78) inset'; });
      const img = document.createElement('img');
      img.className = 'qm-window-icon qm-window-icon--fab'; img.alt = ct('widget.logs') || 'Logs';
      img.src = getRuntimeIconUrl(WIDGET_ICON_BASE, WIDGET_ICONS.logs);
      b.appendChild(img);
      return b;
    })();
    edgeWrap.append(historyFab, chatFab, logsFab);

    const mkPanel = (key, title) => {
      const cfg = getWindowConfig(key);
      const panel = document.createElement('section');
      Object.assign(panel.style, { position:'fixed', left:'20px', top:'20px', width:`${cfg.width}px`, height:`${cfg.height}px`, minHeight:`${cfg.minH || 180}px`, maxWidth:'calc(100vw - 24px)', maxHeight:'calc(100vh - 8px)', background:'var(--qm-surface,linear-gradient(165deg,rgba(255,255,255,0.72),rgba(241,245,252,0.58)))', border:'1px solid var(--qm-border,rgba(255,255,255,0.72))', borderRadius:'var(--qm-radius,16px)', boxShadow:'var(--qm-shadow,0 16px 44px rgba(15,23,42,.20)),0 1px 0 rgba(255,255,255,0.72) inset', backdropFilter:'blur(18px) saturate(1.18)', WebkitBackdropFilter:'blur(18px) saturate(1.18)', zIndex:'2147483645', display:'none', overflow:'visible', boxSizing:'border-box', transition:'box-shadow 0.28s cubic-bezier(0.22,1,0.36,1),border-color 0.28s cubic-bezier(0.22,1,0.36,1)' });
      panel.addEventListener('mouseenter', () => { panel.style.boxShadow='0 24px 56px rgba(15,23,42,0.24),0 1px 0 rgba(255,255,255,0.80) inset,0 0 0 1px rgba(191,219,254,0.18)'; panel.style.borderColor='rgba(191,219,254,0.72)'; });
      panel.addEventListener('mouseleave', () => { panel.style.boxShadow='var(--qm-shadow,0 16px 44px rgba(15,23,42,.20)),0 1px 0 rgba(255,255,255,0.72) inset'; panel.style.borderColor='var(--qm-border,rgba(255,255,255,0.72))'; });
      const hdr = document.createElement('div');
      Object.assign(hdr.style, { padding:'9px 11px', font:'700 12px -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif', borderBottom:'1px solid var(--qm-border,rgba(226,232,240,0.60))', background:'var(--qm-header-bg,linear-gradient(180deg,rgba(255,255,255,0.72) 0%,rgba(248,251,255,0.52) 100%))', display:'flex', alignItems:'center', justifyContent:'space-between', gap:'8px', color:'var(--qm-text-2,#334155)', cursor:'grab' });
      const ttl     = document.createElement('span'); ttl.textContent = title;
      const actions = document.createElement('div');
      Object.assign(actions.style, { display:'flex', alignItems:'center', gap:'6px' });
      const pinBtn   = document.createElement('button'); pinBtn.type = 'button'; pinBtn.dataset.on = 'false'; setWindowButtonIcon(pinBtn, { fileName: WINDOW_ICONS.keep, alt: ct('widget.pin_window') });
      Object.assign(pinBtn.style, { border:'1px solid var(--qm-border,rgba(203,213,225,0.6))', background:'var(--qm-surface-2,rgba(255,255,255,0.68))', borderRadius:'7px', width:'26px', height:'26px', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', padding:'0', transition:'background .18s ease,border-color .18s ease,transform .20s cubic-bezier(0.34,1.26,0.64,1),box-shadow .18s ease' });
      const closeBtn = document.createElement('button'); closeBtn.type = 'button'; setWindowButtonIcon(closeBtn, { fileName: WINDOW_ICONS.close, alt: ct('widget.close') });
      Object.assign(closeBtn.style, { border:'1px solid var(--qm-border,rgba(203,213,225,0.6))', background:'var(--qm-surface-2,rgba(255,255,255,0.68))', borderRadius:'7px', width:'26px', height:'26px', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', padding:'0', transition:'background .18s ease,border-color .18s ease,transform .20s cubic-bezier(0.34,1.26,0.64,1),box-shadow .18s ease' });
      [pinBtn, closeBtn].forEach(btn => {
        btn.addEventListener('mouseenter', () => { btn.style.background='var(--qm-accent-light,rgba(239,246,255,0.92))'; btn.style.borderColor='rgba(147,197,253,0.75)'; btn.style.transform='translateY(-2px) scale(1.08)'; btn.style.boxShadow='0 4px 12px rgba(37,99,235,0.18),0 0 0 2px rgba(37,99,235,0.06)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background='var(--qm-surface-2,rgba(255,255,255,0.68))'; btn.style.borderColor='var(--qm-border,rgba(203,213,225,0.6))'; btn.style.transform=''; btn.style.boxShadow=''; });
        btn.addEventListener('mousedown',  () => { btn.style.transform='scale(0.92)'; btn.style.boxShadow='none'; });
        btn.addEventListener('mouseup',    () => { btn.style.transform=''; btn.style.boxShadow=''; });
      });
      actions.append(pinBtn, closeBtn);
      hdr.append(ttl, actions);
      const body = document.createElement('div');
      Object.assign(body.style, { minHeight:`${Math.max(120, (cfg.minH || 200) - 70)}px`, overflowY:'auto', padding:'10px', font:'12px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif', color:'var(--qm-text,#0f172a)', flex:'1 1 auto' });
      const barWrap = document.createElement('div');
      Object.assign(barWrap.style, { width:'100%', height:'3px', background:'var(--qm-border,rgba(226,232,240,0.55))', flex:'0 0 3px' });
      const bar = document.createElement('div');
      Object.assign(bar.style, { height:'100%', width:'100%', background:'linear-gradient(90deg,rgba(147,197,253,0.8),#2563eb,rgba(124,58,237,0.85))', transformOrigin:'left center', transform:'scaleX(1)' });
      barWrap.appendChild(bar);
      panel.append(hdr, body, barWrap);
      panel.style.display = 'none';
      panel.style.flexDirection = 'column';
      const timer = { rafId: null, endAt: 0, pinned: false };
      const stop  = () => { if (timer.rafId) { cancelAnimationFrame(timer.rafId); timer.rafId = null; } };
      const applyPinUi = () => {
        pinBtn.dataset.on = String(timer.pinned);
        setWindowButtonIcon(pinBtn, { fileName: timer.pinned ? WINDOW_ICONS.keepOff : WINDOW_ICONS.keep, alt: timer.pinned ? ct('widget.unpin_window') : ct('widget.pin_window') });
        pinBtn.title = timer.pinned ? ct('widget.unpin_window') : ct('widget.pin_window');
        barWrap.style.display = timer.pinned ? 'none' : 'block';
      };
      const start = () => {
        stop(); applyPinUi();
        if (timer.pinned || panel.style.display === 'none' || panel.classList.contains('qm-panel--hiding') || (key === 'chat' && (isGptChatLoaderActive() || isChatFilePickerActive()))) return;
        timer.endAt = Date.now() + WIDGET_TIMER_MS;
        bar.style.transform = 'scaleX(1)';
        const tick = () => {
          if (timer.pinned || panel.style.display === 'none' || panel.classList.contains('qm-panel--hiding')) { stop(); return; }
          if (key === 'chat' && (isGptChatLoaderActive() || isChatFilePickerActive())) { bar.style.transform = 'scaleX(1)'; stop(); return; }
          if (panel.matches(':hover')) timer.endAt = Date.now() + WIDGET_TIMER_MS;
          const left = Math.max(0, timer.endAt - Date.now());
          bar.style.transform = `scaleX(${Math.max(0, left / WIDGET_TIMER_MS)})`;
          if (left <= 0) { WindowManager.hideWindow(key, { persist: true, stopTimer: true }); return; }
          timer.rafId = requestAnimationFrame(tick);
        };
        timer.rafId = requestAnimationFrame(tick);
      };
      pinBtn.addEventListener('click', () => { timer.pinned = !timer.pinned; applyPinUi(); if (timer.pinned) stop(); else start(); });
      closeBtn.addEventListener('click', () => {
        WindowManager.hideWindow(key, { persist: true, stopTimer: true });
      });
      return { panel, hdr, body, bar, barWrap, pinBtn, closeBtn, timer, startTimer:start, stopTimer:stop, applyPinUi };
    };

    const historyPanel = mkPanel('history', 'History');
    const chatPanel    = mkPanel('chat', 'Chat');
    const logsPanel    = mkPanel('logs', ct('widget.logs') || 'Logs');

    // Logs panel has no auto-close timer: hide progress bar and pin button
    logsPanel.barWrap.style.display = 'none';
    logsPanel.pinBtn.style.display  = 'none';

    WindowManager.createWindow('answer', {
      panel: widget,
      getPinned:    () => widgetPinned,
      startTimer:   () => timerStart(WIDGET_TIMER_MS),
      stopTimer:    () => timerStop(),
      persistRect:  () => {
        if (isAnswerDefaultLayoutMode()) return;
        persistWindowRect('answer', widget);
      },
      updateLayout: () => updateAnswerLayout(),
      restoreRect:  () => {
        const rect = getWindowRect('answer');
        applyAnswerFrame(widget, { x: rect.x, y: rect.y, width: rect.width }, { width: rect.width || getWindowConfig('answer').width });
      },
    });
    WindowManager.createWindow('history', {
      panel: historyPanel.panel,
      getPinned:   () => Boolean(historyPanel.timer?.pinned),
      startTimer:  () => historyPanel.startTimer?.(),
      stopTimer:   () => historyPanel.stopTimer?.(),
      persistRect: () => persistWindowRect('history', historyPanel.panel),
      restoreRect: () => applyPanelLayoutOrDefault('history', historyPanel.panel, { width:getWindowConfig('history').width, height:getWindowConfig('history').height }),
    });
    WindowManager.createWindow('chat', {
      panel: chatPanel.panel,
      getPinned:   () => Boolean(chatPanel.timer?.pinned),
      startTimer:  () => chatPanel.startTimer?.(),
      stopTimer:   () => chatPanel.stopTimer?.(),
      persistRect: () => persistWindowRect('chat', chatPanel.panel),
      restoreRect: () => applyPanelLayoutOrDefault('chat', chatPanel.panel, { width:getWindowConfig('chat').width, height:getWindowConfig('chat').height }),
    });
    WindowManager.createWindow('logs', {
      panel: logsPanel.panel,
      getPinned:   () => false,
      startTimer:  () => {},
      stopTimer:   () => {},
      persistRect: () => persistWindowRect('logs', logsPanel.panel),
      restoreRect: () => applyPanelLayoutOrDefault('logs', logsPanel.panel, { width:getWindowConfig('logs').width, height:getWindowConfig('logs').height }),
    });

    /* ── Logs panel inner ── */
    {
      // ── Add download & clear buttons to the logs header (before close) ──
      const lHdrDlBtn = document.createElement('button'); lHdrDlBtn.type = 'button'; lHdrDlBtn.textContent = 'Download';
      Object.assign(lHdrDlBtn.style, { border:'1px solid var(--qm-border,rgba(203,213,225,0.6))', background:'var(--qm-surface-2,rgba(255,255,255,0.68))', color:'var(--qm-text-2,#334155)', borderRadius:'7px', padding:'3px 10px', font:'600 10px Inter,sans-serif', cursor:'pointer', transition:'background .18s ease,border-color .18s ease,transform .20s cubic-bezier(0.34,1.26,0.64,1),box-shadow .18s ease' });
      lHdrDlBtn.addEventListener('mouseenter', () => { lHdrDlBtn.style.background='var(--qm-accent-light,rgba(239,246,255,0.92))'; lHdrDlBtn.style.borderColor='rgba(147,197,253,0.75)'; lHdrDlBtn.style.transform='translateY(-1px)'; lHdrDlBtn.style.boxShadow='0 3px 10px rgba(37,99,235,0.14)'; });
      lHdrDlBtn.addEventListener('mouseleave', () => { lHdrDlBtn.style.background='var(--qm-surface-2,rgba(255,255,255,0.68))'; lHdrDlBtn.style.borderColor='var(--qm-border,rgba(203,213,225,0.6))'; lHdrDlBtn.style.transform=''; lHdrDlBtn.style.boxShadow=''; });
      lHdrDlBtn.addEventListener('mousedown',  () => { lHdrDlBtn.style.transform='scale(0.96)'; });
      lHdrDlBtn.addEventListener('mouseup',    () => { lHdrDlBtn.style.transform=''; });
      lHdrDlBtn.addEventListener('click', () => qmDownloadLog());

      const lHdrClrBtn = document.createElement('button'); lHdrClrBtn.type = 'button'; lHdrClrBtn.textContent = 'Clear';
      Object.assign(lHdrClrBtn.style, { border:'1px solid rgba(220,38,38,0.35)', background:'rgba(220,38,38,0.06)', color:'#dc2626', borderRadius:'7px', padding:'3px 10px', font:'600 10px Inter,sans-serif', cursor:'pointer', transition:'background .18s ease,border-color .18s ease,transform .20s cubic-bezier(0.34,1.26,0.64,1),box-shadow .18s ease' });
      lHdrClrBtn.addEventListener('mouseenter', () => { lHdrClrBtn.style.background='rgba(220,38,38,0.12)'; lHdrClrBtn.style.borderColor='rgba(220,38,38,0.6)'; lHdrClrBtn.style.transform='translateY(-1px)'; lHdrClrBtn.style.boxShadow='0 3px 10px rgba(220,38,38,0.20)'; });
      lHdrClrBtn.addEventListener('mouseleave', () => { lHdrClrBtn.style.background='rgba(220,38,38,0.06)'; lHdrClrBtn.style.borderColor='rgba(220,38,38,0.35)'; lHdrClrBtn.style.transform=''; lHdrClrBtn.style.boxShadow=''; });
      lHdrClrBtn.addEventListener('mousedown',  () => { lHdrClrBtn.style.transform='scale(0.96)'; });
      lHdrClrBtn.addEventListener('mouseup',    () => { lHdrClrBtn.style.transform=''; });
      lHdrClrBtn.addEventListener('click', () => { if (confirm('Clear all logs?')) window.__QM_CLEAR_LOG?.(); });

      // Insert before the close button
      const lHdrActions = logsPanel.hdr.lastChild;
      lHdrActions.insertBefore(lHdrClrBtn, logsPanel.closeBtn);
      lHdrActions.insertBefore(lHdrDlBtn, lHdrClrBtn);

      // Add entry badge next to the title in the header
      const lHdrBadge = document.createElement('span'); lHdrBadge.className = 'qp-badge';
      Object.assign(lHdrBadge.style, { font:'500 10px Inter,sans-serif', color:'var(--qm-text-2,#64748b)', background:'var(--qm-surface-2,rgba(241,245,249,0.8))', border:'1px solid var(--qm-border,rgba(226,232,240,0.6))', borderRadius:'5px', padding:'1px 7px', marginLeft:'6px' });
      lHdrBadge.textContent = '0';
      logsPanel.hdr.firstChild.after(lHdrBadge);

      // ── Body layout ──
      const lBody = logsPanel.body;
      Object.assign(lBody.style, { padding:'0', overflow:'hidden', display:'flex', flexDirection:'column' });

      // ── Filter bar: search + All + category chips ──
      const lFbar = document.createElement('div');
      Object.assign(lFbar.style, { display:'flex', flexWrap:'wrap', gap:'4px', padding:'5px 10px', borderBottom:'1px solid var(--qm-border,rgba(226,232,240,0.6))', alignItems:'center', flexShrink:'0', background:'var(--qm-header-bg,rgba(248,251,255,0.45))' });

      const lSrch = document.createElement('input'); lSrch.className = 'qp-search'; lSrch.placeholder = 'Search…'; lSrch.type = 'text';
      Object.assign(lSrch.style, { border:'1px solid var(--qm-border,rgba(203,213,225,0.6))', borderRadius:'6px', padding:'3px 9px', font:'10px Inter,sans-serif', background:'var(--qm-surface,rgba(255,255,255,0.72))', color:'var(--qm-text,#0f172a)', width:'140px', flexShrink:'0', outline:'none', backdropFilter:'blur(4px)', transition:'border-color .15s ease' });
      lSrch.addEventListener('focus', () => { lSrch.style.borderColor='rgba(59,130,246,0.6)'; lSrch.style.boxShadow='0 0 0 2px rgba(59,130,246,0.12)'; });
      lSrch.addEventListener('blur',  () => { lSrch.style.borderColor='var(--qm-border,rgba(203,213,225,0.6))'; lSrch.style.boxShadow=''; });

      const lActiveCats = new Set(Object.keys(_QML?.CAT_COLORS_QM ?? {}));
      logsPanel.panel._activeCats = lActiveCats;

      const lAllBtn = document.createElement('button');
      Object.assign(lAllBtn.style, { background:'var(--qm-surface-2,rgba(241,245,249,0.85))', color:'var(--qm-text-2,#334155)', border:'1px solid var(--qm-border,rgba(203,213,225,0.6))', borderRadius:'5px', padding:'2px 8px', fontSize:'9px', fontWeight:'700', cursor:'pointer', flexShrink:'0', transition:'background .15s ease,transform .12s ease' });
      lAllBtn.textContent = 'All';
      lAllBtn.addEventListener('mouseenter', () => { lAllBtn.style.background='var(--qm-accent-light,rgba(239,246,255,0.92))'; });
      lAllBtn.addEventListener('mouseleave', () => { lAllBtn.style.background='var(--qm-surface-2,rgba(241,245,249,0.85))'; });

      let lAllOn = true;
      lAllBtn.addEventListener('click', () => {
        lAllOn = !lAllOn;
        Object.keys(_QML?.CAT_COLORS_QM ?? {}).forEach(c => {
          if (lAllOn) lActiveCats.add(c); else lActiveCats.delete(c);
          const b = lFbar.querySelector('[data-qcat="' + c + '"]');
          if (b) b.style.opacity = lActiveCats.has(c) ? '1' : '0.25';
        });
        lAllBtn.style.background = lAllOn ? 'var(--qm-surface-2,rgba(241,245,249,0.85))' : 'rgba(220,38,38,0.08)';
        _QML?.applyFilter(logsPanel.panel, lSrch.value);
      });

      Object.entries(_QML?.CAT_COLORS_QM ?? {}).forEach(([cat, col]) => {
        const b = document.createElement('button');
        b.dataset.qcat = cat; b.textContent = cat;
        Object.assign(b.style, { background: col + '18', color: col, border: '1px solid ' + col + '80', borderRadius: '5px', padding: '2px 6px', font: '700 9px Inter,sans-serif', cursor: 'pointer', flexShrink: '0', opacity: '1', transition: 'opacity .15s ease,transform .12s ease,box-shadow .15s ease' });
        b.addEventListener('mouseenter', () => { if (b.style.opacity !== '0.25') b.style.boxShadow='0 2px 6px ' + col + '40'; b.style.transform='translateY(-1px)'; });
        b.addEventListener('mouseleave', () => { b.style.boxShadow=''; b.style.transform=''; });
        b.addEventListener('click', () => {
          if (lActiveCats.has(cat)) { lActiveCats.delete(cat); b.style.opacity = '0.25'; }
          else { lActiveCats.add(cat); b.style.opacity = '1'; }
          _QML?.applyFilter(logsPanel.panel, lSrch.value);
        });
        lFbar.append(b);
      });
      lSrch.addEventListener('input', () => _QML?.applyFilter(logsPanel.panel, lSrch.value));
      lFbar.prepend(lSrch, lAllBtn);

      // ── Log rows body ──
      const lRows = document.createElement('div'); lRows.className = 'qp-body';
      Object.assign(lRows.style, { overflowY:'auto', flex:'1 1 auto', padding:'0' });

      lBody.append(lFbar, lRows);

      // Set the shared panel reference so _renderQmPanel / _installPanelUpdate can find the panel
      _QML?.attachPanel(logsPanel.panel);
      logsPanel.panel._srch = lSrch;
      logsPanel.panel._hdrBadge = lHdrBadge;

      // Wire close button to also clear real-time update callbacks
      logsPanel.closeBtn.addEventListener('click', () => {
        _QML?.clearCallbacks();
      });
    }

    /* ── Chat panel inner ── */
    const chatTop = document.createElement('div');
    Object.assign(chatTop.style, { display:'grid', gridTemplateColumns:'1fr', gap:'6px', padding:'8px 10px', borderBottom:'1px solid var(--qm-border,#e2e8f0)', width:'100%', boxSizing:'border-box' });
    const chatModelRow = document.createElement('div');
    Object.assign(chatModelRow.style, { display:'grid', gridTemplateColumns:'1fr auto', gap:'8px', alignItems:'center', width:'100%' });
    const chatModelCurrent = document.createElement('div');
    Object.assign(chatModelCurrent.style, { font:'600 12px Inter,sans-serif', color:'var(--qm-text,#0f172a)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' });
    const chatModelActions = document.createElement('div');
    Object.assign(chatModelActions.style, { display:'flex', alignItems:'center', gap:'6px' });
    const chatClearBtn = document.createElement('button'); chatClearBtn.type = 'button'; chatClearBtn.textContent = ct('widget.chat_clear_history');
    Object.assign(chatClearBtn.style, { border:'1px solid var(--qm-border,#cbd5e1)', background:'var(--qm-surface,#fff)', color:'var(--qm-muted,#64748b)', borderRadius:'8px', padding:'4px 8px', font:'600 11px Inter,sans-serif', cursor:'pointer', transition:'background 0.18s ease,border-color 0.18s ease,color 0.18s ease' });
    chatClearBtn.addEventListener('mouseenter', () => { chatClearBtn.style.background='var(--qm-surface-2,#f8fafc)'; chatClearBtn.style.borderColor='rgba(148,163,184,0.75)'; chatClearBtn.style.color='var(--qm-text-2,#334155)'; });
    chatClearBtn.addEventListener('mouseleave', () => { chatClearBtn.style.background='var(--qm-surface,#fff)'; chatClearBtn.style.borderColor='var(--qm-border,#cbd5e1)'; chatClearBtn.style.color='var(--qm-muted,#64748b)'; });
    const chatChangeModelBtn = document.createElement('button'); chatChangeModelBtn.type = 'button'; chatChangeModelBtn.textContent = ct('widget.change');
    Object.assign(chatChangeModelBtn.style, { border:'1px solid var(--qm-border,#cbd5e1)', background:'var(--qm-surface,#fff)', color:'var(--qm-text-2,#334155)', borderRadius:'8px', padding:'4px 8px', font:'600 11px Inter,sans-serif', cursor:'pointer', transition:'background 0.18s ease,border-color 0.18s ease,transform 0.20s cubic-bezier(0.22,1,0.36,1),box-shadow 0.18s ease' });
    chatChangeModelBtn.addEventListener('mouseenter', () => { chatChangeModelBtn.style.background='var(--qm-accent-light,rgba(239,246,255,0.92))'; chatChangeModelBtn.style.borderColor='rgba(147,197,253,0.75)'; chatChangeModelBtn.style.transform='translateY(-1px)'; chatChangeModelBtn.style.boxShadow='0 3px 10px rgba(37,99,235,0.12)'; });
    chatChangeModelBtn.addEventListener('mouseleave', () => { chatChangeModelBtn.style.background='var(--qm-surface,#fff)'; chatChangeModelBtn.style.borderColor='var(--qm-border,#cbd5e1)'; chatChangeModelBtn.style.transform=''; chatChangeModelBtn.style.boxShadow=''; });
    chatChangeModelBtn.addEventListener('mousedown', () => { chatChangeModelBtn.style.transform='scale(0.96)'; });
    chatChangeModelBtn.addEventListener('mouseup',   () => { chatChangeModelBtn.style.transform=''; });
    chatModelActions.append(chatClearBtn, chatChangeModelBtn);
    chatModelRow.append(chatModelCurrent, chatModelActions);
    const chatModelPicker = document.createElement('div');
    Object.assign(chatModelPicker.style, { display:'none', gap:'6px', width:'100%' });
    const chatModelInput = document.createElement('input'); chatModelInput.placeholder = ct('widget.chat_model_placeholder');
    Object.assign(chatModelInput.style, { font:'12px Inter,sans-serif', border:'1px solid var(--qm-border,#cbd5e1)', borderRadius:'8px', padding:'6px 8px', width:'100%', boxSizing:'border-box', background:'var(--qm-input-bg,#fff)', color:'var(--qm-text,#0f172a)' });
    const chatModelList = document.createElement('div');
    chatModelList.className = 'chat-mdl-list';
    chatModelPicker.append(chatModelInput, chatModelList);
    chatTop.append(chatModelRow, chatModelPicker);
    const chatMsgs = document.createElement('div');
    Object.assign(chatMsgs.style, { minHeight:'100px', overflowY:'auto', padding:'10px', display:'grid', gap:'8px', alignContent:'start', alignItems:'start', gridAutoRows:'max-content', flex:'1 1 auto', width:'100%', boxSizing:'border-box', scrollBehavior:'auto' });
    const chatInputRow = document.createElement('div');
    Object.assign(chatInputRow.style, { display:'grid', gridTemplateColumns:'1fr', gap:'6px', padding:'8px 10px 12px', borderTop:'1px solid var(--qm-border,#e2e8f0)', width:'100%', minHeight:'0', boxSizing:'border-box', flex:'0 0 auto', overflow:'hidden' });
    const chatInput = document.createElement('textarea'); chatInput.placeholder = ct('widget.chat_write_message'); chatInput.dataset.qmChatInput = 'true';
    Object.assign(chatInput.style, { border:'1px solid var(--qm-border,#cbd5e1)', borderRadius:'8px', padding:'6px 8px', font:'12px Inter,sans-serif', minHeight:'38px', maxHeight:'120px', resize:'vertical', lineHeight:'1.4', width:'100%', boxSizing:'border-box', background:'var(--qm-input-bg,#fff)', color:'var(--qm-text,#1f2937)', transition:'border-color 0.20s ease,box-shadow 0.20s ease', outline:'none' });
    chatInput.addEventListener('mouseenter', () => { if (document.activeElement !== chatInput) { chatInput.style.borderColor='rgba(147,197,253,0.70)'; chatInput.style.boxShadow='0 0 0 2px rgba(37,99,235,0.08),0 2px 6px rgba(37,99,235,0.06)'; } });
    chatInput.addEventListener('mouseleave', () => { if (document.activeElement !== chatInput) { chatInput.style.borderColor='var(--qm-border,#cbd5e1)'; chatInput.style.boxShadow=''; } });
    chatInput.addEventListener('focus', () => { chatInput.style.borderColor='var(--qm-accent,#3b82f6)'; chatInput.style.boxShadow='0 0 0 2.5px rgba(37,99,235,0.16),0 3px 10px rgba(37,99,235,0.09)'; });
    chatInput.addEventListener('blur',  () => { if (chatInput.matches(':hover')) { chatInput.style.borderColor='rgba(147,197,253,0.70)'; chatInput.style.boxShadow='0 0 0 2px rgba(37,99,235,0.08),0 2px 6px rgba(37,99,235,0.06)'; } else { chatInput.style.borderColor='var(--qm-border,#cbd5e1)'; chatInput.style.boxShadow=''; } });
    const chatComposerRow = document.createElement('div');
    chatComposerRow.className = 'chat-composer-row';
    const chatAttachButton = document.createElement('button');
    chatAttachButton.type = 'button';
    chatAttachButton.className = 'chat-attach-button';
    chatAttachButton.title = ct('widget.chat_attach_file');
    chatAttachButton.setAttribute('aria-label', ct('widget.chat_attach_file'));
    chatAttachButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8.5 12.5 6.2-6.2a3.2 3.2 0 0 1 4.5 4.5l-8.1 8.1a5 5 0 0 1-7.1-7.1l8.1-8.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="m7.1 15.1 7.4-7.4a1.4 1.4 0 1 1 2 2l-7.4 7.4a2.2 2.2 0 0 1-3.1-3.1l6.8-6.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
    const chatFileInput = document.createElement('input');
    chatFileInput.type = 'file';
    chatFileInput.multiple = true;
    chatFileInput.accept = CHAT_FILE_INPUT_ACCEPT;
    chatFileInput.className = 'chat-file-input';
    chatComposerRow.append(chatInput, chatAttachButton, chatFileInput);
    const chatPendingImages = document.createElement('div');
    chatPendingImages.className = 'chat-pending-images';
    chatPendingImages.setAttribute('aria-live', 'polite');
    const chatPendingFiles = document.createElement('div');
    chatPendingFiles.className = 'chat-pending-files';
    chatPendingFiles.setAttribute('aria-live', 'polite');
    const chatInputStatus = document.createElement('div');
    chatInputStatus.className = 'chat-input-status';
    chatInputStatus.setAttribute('role', 'status');
    const chatSend = document.createElement('button'); chatSend.type = 'button'; chatSend.className = 'chat-send-button'; chatSend.textContent = ct('widget.chat_send');
    Object.assign(chatSend.style, { border:'1px solid var(--qm-accent,#93c5fd)', background:'var(--qm-accent,#3b82f6)', color:'var(--qm-surface,#ffffff)', borderRadius:'8px', padding:'6px 10px', font:'600 12px Inter,sans-serif', cursor:'pointer', width:'100%', boxSizing:'border-box', transition:'background 0.18s ease,transform 0.20s cubic-bezier(0.34,1.26,0.64,1),box-shadow 0.18s ease,filter 0.15s ease' });
    chatSend.addEventListener('mouseenter', () => { chatSend.style.filter='brightness(1.09)'; chatSend.style.transform='translateY(-1px)'; chatSend.style.boxShadow='0 5px 16px rgba(37,99,235,0.30)'; });
    chatSend.addEventListener('mouseleave', () => { chatSend.style.filter=''; chatSend.style.transform=''; chatSend.style.boxShadow=''; });
    chatSend.addEventListener('mousedown', () => { chatSend.style.transform='scale(0.97)'; chatSend.style.filter='brightness(0.95)'; });
    chatSend.addEventListener('mouseup',   () => { chatSend.style.transform=''; chatSend.style.filter=''; });
    chatInputRow.append(chatComposerRow, chatPendingImages, chatPendingFiles, chatInputStatus, chatSend);
    const chatContent = document.createElement('div');
    Object.assign(chatContent.style, { display:'flex', flexDirection:'column', minHeight:'100%', height:'100%', width:'100%' });
    chatContent.append(chatTop, chatMsgs, chatInputRow);
    const chatImagePreviewOverlay = document.createElement('div');
    chatImagePreviewOverlay.className = 'chat-image-preview-overlay';
    chatImagePreviewOverlay.setAttribute('role', 'dialog');
    chatImagePreviewOverlay.setAttribute('aria-modal', 'true');
    const chatImagePreviewImage = document.createElement('img');
    chatImagePreviewImage.className = 'chat-image-preview-full';
    chatImagePreviewImage.alt = ct('widget.chat_attached_image');
    const chatImagePreviewClose = document.createElement('button');
    chatImagePreviewClose.type = 'button';
    chatImagePreviewClose.className = 'chat-image-preview-close';
    chatImagePreviewClose.textContent = '×';
    chatImagePreviewClose.title = ct('widget.chat_close_preview');
    chatImagePreviewClose.setAttribute('aria-label', ct('widget.chat_close_preview'));
    chatImagePreviewOverlay.append(chatImagePreviewImage, chatImagePreviewClose);
    chatPanel.body.style.padding   = '0';
    chatPanel.body.style.overflow  = 'hidden';
    chatPanel.body.style.display   = 'flex';
    chatPanel.body.appendChild(chatContent);

    /* ── Log panel Shadow DOM CSS ── */
    const logPanelStyle = document.createElement('style');
    logPanelStyle.textContent = `
      @keyframes chat-msg-in { from { opacity:0; transform:translateY(8px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .qp-body { font:10px/1.4 "SF Mono","Fira Code",Inter,monospace; color:var(--qm-text,#111827); }
      .qp-row {
        display:flex; gap:6px; padding:3px 10px;
        border-bottom:1px solid var(--qm-border,rgba(226,232,240,0.7));
        align-items:flex-start; border-radius:4px; margin:0 3px;
        transition:background 0.14s ease, transform 0.18s cubic-bezier(0.22,1,0.36,1), box-shadow 0.14s ease;
      }
      .qp-row:hover { background:rgba(37,99,235,0.05); transform:translateX(3px); box-shadow:-2px 0 0 rgba(37,99,235,0.28); }
      .qp-row.err { background:rgba(220,38,38,0.08); }
      .qp-row.err:hover { background:rgba(220,38,38,0.13); transform:translateX(3px); box-shadow:-2px 0 0 rgba(220,38,38,0.45); }
      .qp-row.ai  { background:rgba(16,185,129,0.06); }
      .qp-row.ai:hover  { background:rgba(16,185,129,0.11); transform:translateX(3px); box-shadow:-2px 0 0 rgba(16,185,129,0.45); }
      .qp-ts { color:var(--qm-muted,#94a3b8); flex-shrink:0; font-size:9px; padding-top:2px; }
      .qp-cat-lbl { font-weight:700; flex-shrink:0; min-width:50px; font-size:9px; padding-top:2px; }
      .qp-msg { color:var(--qm-text,#1f2937); flex:1; word-break:break-all; white-space:pre-wrap; line-height:1.5; }
      .qp-tog { color:var(--qm-muted,#94a3b8); cursor:pointer; font-size:9px; user-select:none; transition:color 0.15s ease; }
      .qp-tog:hover { color:rgba(37,99,235,0.9); }
      .qp-detail {
        color:var(--qm-muted,#94a3b8); font-size:9px;
        border-left:2px solid rgba(37,99,235,0.28); padding-left:6px; margin-top:3px;
        word-break:break-all;
        max-height:0; overflow:hidden; opacity:0;
        transition:max-height 0.20s cubic-bezier(0.22,1,0.36,1), opacity 0.18s ease;
      }
      .qp-detail.open { max-height:500px; opacity:0.9; }
      .qp-empty { color:var(--qm-muted,#94a3b8); font-size:11px; padding:24px; text-align:center; line-height:1.6; }
      .qp-body::-webkit-scrollbar { width:3px; }
      .qp-body::-webkit-scrollbar-track { background:transparent; }
      .qp-body::-webkit-scrollbar-thumb { background:rgba(148,163,184,0.35); border-radius:999px; transition:background 0.2s ease; }
      .qp-body::-webkit-scrollbar-thumb:hover { background:rgba(37,99,235,0.35); }
      .chat-bubble { width:fit-content; height:auto; min-height:0; align-self:start; transition:transform 0.20s cubic-bezier(0.22,1,0.36,1), box-shadow 0.20s ease; }
      .chat-bubble:hover { transform:translateY(-1px); box-shadow:0 4px 14px rgba(37,99,235,0.10), 0 0 0 1px rgba(147,197,253,0.22); }
      .chat-bubble--user { background:var(--qm-accent-light,#dbeafe); color:var(--qm-text-2,#1e3a8a); border:1px solid rgba(191,219,254,0.60); }
      .chat-bubble--user:hover { background:rgba(219,234,254,0.92); }
      .chat-bubble--assistant { position:relative; padding:10px 38px 10px 14px !important; background:var(--qm-surface-2,#f1f5f9); color:var(--qm-text,#1f2937); border:1px solid var(--qm-border,rgba(226,232,240,0.65)); }
      .chat-bubble--assistant:hover { background:rgba(248,250,252,0.96); }
      .chat-bubble--assistant ul,
      .chat-bubble--assistant ol { margin:6px 0 8px; padding-left:24px; list-style-position:outside; }
      .chat-bubble--assistant li { margin:3px 0; padding-left:2px; }
      .chat-bubble--assistant p { margin:0 0 7px; }
      .chat-bubble--assistant p:last-child { margin-bottom:0; }
      .chat-copy-button { position:absolute; top:7px; right:7px; width:25px; height:25px; display:grid; place-items:center; border:1px solid var(--qm-border,#cbd5e1); border-radius:7px; padding:0; background:rgba(255,255,255,0.78); color:var(--qm-text-2,#334155); cursor:pointer; transition:background 0.15s ease,border-color 0.15s ease,color 0.15s ease,transform 0.18s cubic-bezier(0.22,1,0.36,1); }
      .chat-copy-button:hover { background:rgba(239,246,255,0.98); border-color:rgba(147,197,253,0.85); color:var(--qm-accent,#2563eb); transform:translateY(-1px); }
      .chat-copy-button:active { transform:scale(0.94); }
      .chat-copy-button svg { width:14px; height:14px; display:block; pointer-events:none; }
      .chat-composer-row { display:grid; grid-template-columns:minmax(0,1fr) 32px; align-items:start; gap:6px; width:100%; }
      .chat-attach-button { width:32px; height:32px; display:grid; place-items:center; border:1px solid var(--qm-border,#cbd5e1); border-radius:8px; padding:0; background:var(--qm-surface,#fff); color:var(--qm-text-2,#334155); cursor:pointer; transition:background .15s ease,border-color .15s ease,color .15s ease,transform .15s ease; }
      .chat-attach-button:hover { background:var(--qm-accent-light,#eff6ff); border-color:rgba(147,197,253,.9); color:var(--qm-accent,#2563eb); transform:translateY(-1px); }
      .chat-attach-button:disabled { opacity:.55; cursor:progress; transform:none; }
      .chat-attach-button svg { width:17px; height:17px; pointer-events:none; }
      .chat-file-input { display:none !important; }
      .chat-pending-images { display:flex; flex-wrap:wrap; gap:6px; max-width:100%; align-items:start; }
      .chat-pending-files,
      .chat-message-files { display:flex; flex-direction:column; gap:5px; width:min(100%,320px); max-width:100%; min-width:0; margin-top:6px; }
      .chat-pending-files { margin-top:0; max-height:96px; overflow-x:hidden; overflow-y:auto; padding-right:2px; overscroll-behavior:contain; }
      .chat-pending-files::-webkit-scrollbar { width:3px; }
      .chat-pending-files::-webkit-scrollbar-track { background:transparent; }
      .chat-pending-files::-webkit-scrollbar-thumb { background:rgba(148,163,184,.4); border-radius:999px; }
      .chat-message-files { overflow:hidden; }
      .chat-file-chip { display:flex; align-items:center; gap:7px; width:100%; max-width:100%; min-width:0; flex:0 0 auto; padding:6px 7px; box-sizing:border-box; border:1px solid rgba(148,163,184,.45); border-radius:9px; background:rgba(248,250,252,.86); color:var(--qm-text,#1f2937); }
      .chat-file-chip[data-pruned=true] { opacity:.68; }
      .chat-file-kind { width:34px; height:30px; flex:0 0 34px; display:grid; place-items:center; border-radius:7px; background:rgba(219,234,254,.9); color:#1d4ed8; font:700 9px/1 Inter,sans-serif; letter-spacing:.02em; }
      .chat-file-info { display:flex; align-items:baseline; gap:6px; flex:1 1 auto; min-width:0; overflow:hidden; }
      .chat-file-name { display:block; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:600 10px/1.3 Inter,sans-serif; }
      .chat-file-meta { display:block; flex:0 0 auto; min-width:max-content; margin-top:0; white-space:nowrap; color:var(--qm-muted,#64748b); font:9px/1.25 Inter,sans-serif; }
      .chat-file-remove { width:20px; height:20px; flex:0 0 20px; display:grid; place-items:center; border:1px solid rgba(148,163,184,.65); border-radius:50%; padding:0; background:var(--qm-surface,#fff); color:var(--qm-text,#0f172a); font:700 12px/1 Inter,sans-serif; cursor:pointer; }
      .chat-message-images { display:grid; grid-template-columns:repeat(2,minmax(108px,160px)); gap:8px; width:fit-content; max-width:100%; margin-top:6px; align-items:start; justify-content:start; }
      .chat-message-image-button { display:block; width:100%; height:auto; min-width:0; border:0; padding:0; border-radius:8px; background:transparent; cursor:zoom-in; line-height:0; }
      .chat-message-image { display:block; width:100%; aspect-ratio:4/3; height:auto; max-height:150px; object-fit:contain; border-radius:8px; border:1px solid rgba(148,163,184,0.45); background:rgba(248,250,252,0.88); }
      .chat-pending-image { position:relative; width:58px; height:44px; }
      .chat-pending-image img { width:100%; height:100%; object-fit:cover; border-radius:7px; border:1px solid rgba(147,197,253,0.8); }
      .chat-pending-remove { position:absolute; top:-5px; right:-5px; width:18px; height:18px; display:grid; place-items:center; border:1px solid rgba(148,163,184,0.75); border-radius:50%; padding:0; background:var(--qm-surface,#fff); color:var(--qm-text,#0f172a); font:700 12px/1 Inter,sans-serif; cursor:pointer; }
      .chat-input-status { display:none; color:var(--qm-muted,#64748b); font:10px/1.35 Inter,sans-serif; }
      .chat-input-status[data-error=true] { color:#b91c1c; }
      .chat-send-button { min-height:32px; flex-shrink:0; }
      .chat-send-button:disabled { cursor:progress; opacity:0.72; filter:none !important; transform:none !important; box-shadow:none !important; }
      .chat-image-preview-overlay { position:fixed; inset:0; z-index:2147483647; display:none; align-items:center; justify-content:center; padding:28px; box-sizing:border-box; background:rgba(15,23,42,0.72); backdrop-filter:blur(5px); -webkit-backdrop-filter:blur(5px); }
      .chat-image-preview-overlay[data-open=true] { display:flex; }
      .chat-image-preview-full { max-width:min(92vw,1200px); max-height:88vh; object-fit:contain; border-radius:10px; background:#fff; box-shadow:0 24px 70px rgba(15,23,42,0.48); }
      .chat-image-preview-close { position:absolute; top:18px; right:18px; width:38px; height:38px; display:grid; place-items:center; border:1px solid rgba(255,255,255,0.6); border-radius:50%; background:rgba(255,255,255,0.94); color:#0f172a; font:500 28px/1 Inter,sans-serif; cursor:pointer; }
      @media (prefers-reduced-motion:reduce) {
        .qp-row { transition:none !important; }
        .qp-row:hover { transform:none !important; box-shadow:none !important; }
        .qp-detail { transition:none !important; }
        .chat-bubble { transition:none !important; animation:none !important; }
        .chat-bubble:hover { transform:none !important; box-shadow:none !important; }
      }
    `;
    sr.append(logPanelStyle, edgeWrap, historyPanel.panel, chatPanel.panel, chatImagePreviewOverlay, logsPanel.panel);

    applyPanelLayoutOrDefault('history', historyPanel.panel, { width:getWindowConfig('history').width, height:getWindowConfig('history').height });
    applyPanelLayoutOrDefault('chat',    chatPanel.panel,    { width:getWindowConfig('chat').width,    height:getWindowConfig('chat').height    });
    applyPanelLayoutOrDefault('logs',    logsPanel.panel,    { width:getWindowConfig('logs').width,    height:getWindowConfig('logs').height    });

    let chatHistory = [];
    let chatHistoryReady = null;
    let chatRequestError = '';
    let chatClearEpoch = 0;
    let chatCatalog   = [];
    let chatFavorites = [];
    let pendingChatImages = [];
    let pendingChatFiles = [];
    let chatAttachmentError = '';
    let chatImagePasteEpoch = 0;
    let chatQueuedImageCount = 0;
    let chatImageProcessing = Promise.resolve();
    let chatFileSelectionEpoch = 0;
    let chatQueuedFileCount = 0;
    let chatQueuedFileBytes = 0;
    let chatFileProcessing = Promise.resolve();
    let chatRequestInFlight = false;
    let chatSendPreparing = false;
    let chatRequestImageCount = 0;
    let chatRequestFileCount = 0;
    let chatPdfOcrRetryActive = false;
    let chatClosedManuallyDuringRequest = false;
    let chatFilePickerProcessing = false;
    let chatFilePickerReturnTimer = null;
    let chatFilePickerReleaseTimer = null;
    let chatFilePickerGraceUntil = 0;
    let chatScrollFrame = null;
    let chatScrollFollowupFrame = null;
    let chatScrollFollowupTimer = null;

    chatPanel.closeBtn.addEventListener('click', () => {
      if (chatRequestInFlight || chatSendPreparing || chatFilePickerActive || chatFilePickerProcessing) chatClosedManuallyDuringRequest = true;
      chatFilePickerActive = false;
      chatFilePickerProcessing = false;
      clearTimeout(chatFilePickerReturnTimer);
      clearTimeout(chatFilePickerReleaseTimer);
      chatFilePickerGraceUntil = 0;
    });

    function keepChatWindowOpen({ restore = false } = {}) {
      if (chatClosedManuallyDuringRequest) return;
      chatPanel.stopTimer();
      WindowManager.showWindow('chat', { restore, display:'flex', startTimer:false });
    }

    function scrollChatToLatest() {
      const apply = () => { chatMsgs.scrollTop = chatMsgs.scrollHeight; };
      apply();
      if (chatScrollFrame) cancelAnimationFrame(chatScrollFrame);
      if (chatScrollFollowupFrame) cancelAnimationFrame(chatScrollFollowupFrame);
      clearTimeout(chatScrollFollowupTimer);
      chatScrollFrame = requestAnimationFrame(() => {
        apply();
        chatScrollFollowupFrame = requestAnimationFrame(apply);
      });
      chatScrollFollowupTimer = setTimeout(apply, 80);
    }

    function showChatWindowAtLatest({ restore = true, startTimer = true } = {}) {
      const previousVisibility = chatPanel.panel.style.visibility;
      chatPanel.panel.style.visibility = 'hidden';
      WindowManager.showWindow('chat', { restore, display:'flex', startTimer });
      chatMsgs.scrollTop = chatMsgs.scrollHeight;
      chatPanel.panel.getBoundingClientRect();
      chatMsgs.scrollTop = chatMsgs.scrollHeight;
      chatPanel.panel.style.visibility = previousVisibility;
      requestAnimationFrame(() => { chatMsgs.scrollTop = chatMsgs.scrollHeight; });
    }

    function finishChatFilePicker({ focusComposer = true } = {}) {
      clearTimeout(chatFilePickerReturnTimer);
      clearTimeout(chatFilePickerReleaseTimer);
      chatFilePickerProcessing = false;
      if (chatClosedManuallyDuringRequest) {
        chatFilePickerActive = false;
        chatFilePickerGraceUntil = 0;
        return;
      }
      chatFilePickerActive = true;
      chatFilePickerGraceUntil = Date.now() + 450;
      keepChatWindowOpen();
      scrollChatToLatest();
      if (focusComposer) {
        try { chatInput.focus({ preventScroll:true }); } catch { chatInput.focus(); }
        requestAnimationFrame(() => {
          try { chatInput.focus({ preventScroll:true }); } catch { chatInput.focus(); }
        });
      }
      chatFilePickerReleaseTimer = setTimeout(() => {
        chatFilePickerActive = false;
        chatFilePickerGraceUntil = 0;
      }, 450);
    }

    function beginChatFilePicker() {
      clearTimeout(chatFilePickerReturnTimer);
      clearTimeout(chatFilePickerReleaseTimer);
      chatClosedManuallyDuringRequest = false;
      chatFilePickerActive = true;
      chatFilePickerProcessing = false;
      chatFilePickerGraceUntil = 0;
      chatPanel.stopTimer();
      keepChatWindowOpen();
      scrollChatToLatest();
    }

    addManagedListener(window, 'focus', () => {
      if (!chatFilePickerActive) return;
      clearTimeout(chatFilePickerReturnTimer);
      chatFilePickerReturnTimer = setTimeout(() => {
        if (chatFilePickerActive && !chatFilePickerProcessing) finishChatFilePicker();
      }, 250);
    });
    addCleanup(() => {
      clearTimeout(chatFilePickerReturnTimer);
      clearTimeout(chatFilePickerReleaseTimer);
      clearTimeout(chatScrollFollowupTimer);
      if (chatScrollFrame) cancelAnimationFrame(chatScrollFrame);
      if (chatScrollFollowupFrame) cancelAnimationFrame(chatScrollFollowupFrame);
    });

    function closeChatImagePreview() {
      chatImagePreviewOverlay.dataset.open = 'false';
      chatImagePreviewImage.removeAttribute('src');
    }

    function openChatImagePreview(image) {
      if (!image?.dataUrl) return;
      chatImagePreviewImage.src = image.dataUrl;
      chatImagePreviewImage.alt = ct('widget.chat_attached_image');
      chatImagePreviewOverlay.dataset.open = 'true';
      chatImagePreviewClose.focus();
    }

    chatImagePreviewClose.addEventListener('click', closeChatImagePreview);
    chatImagePreviewOverlay.addEventListener('click', event => {
      if (event.target === chatImagePreviewOverlay) closeChatImagePreview();
    });
    addManagedListener(document, 'keydown', event => {
      if (event.key === 'Escape' && chatImagePreviewOverlay.dataset.open === 'true') closeChatImagePreview();
    }, true);

    function formatChatFileSize(bytes) {
      const value = Math.max(0, Number(bytes) || 0);
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
      if (value >= 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
      return `${Math.round(value)} B`;
    }

    function createChatFileChip(file, { removable = false, onRemove = null } = {}) {
      const chip = document.createElement('div');
      chip.className = 'chat-file-chip';
      chip.dataset.pruned = String(file.dataPruned === true);
      const kind = document.createElement('span');
      kind.className = 'chat-file-kind';
      kind.textContent = String(file.extension || 'FILE').toUpperCase().slice(0, 4);
      const info = document.createElement('span');
      info.className = 'chat-file-info';
      const name = document.createElement('span');
      name.className = 'chat-file-name';
      name.textContent = file.filename;
      name.title = file.filename;
      const meta = document.createElement('span');
      meta.className = 'chat-file-meta';
      meta.textContent = file.dataPruned
        ? `${formatChatFileSize(file.bytes)} · ${ct('widget.chat_file_not_resent')}`
        : formatChatFileSize(file.bytes);
      info.append(name, meta);
      chip.append(kind, info);
      if (removable) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chat-file-remove';
        remove.textContent = '×';
        remove.title = ct('widget.chat_remove_file');
        remove.setAttribute('aria-label', ct('widget.chat_remove_file'));
        remove.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); onRemove?.(); });
        chip.appendChild(remove);
      }
      return chip;
    }

    function renderPendingChatAttachments() {
      chatPendingImages.innerHTML = '';
      for (const [index, image] of pendingChatImages.entries()) {
        const item = document.createElement('div');
        item.className = 'chat-pending-image';
        const preview = document.createElement('img');
        preview.src = image.dataUrl;
        preview.alt = ct('widget.chat_attached_image');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chat-pending-remove';
        remove.textContent = '×';
        remove.title = ct('widget.chat_remove_image');
        remove.setAttribute('aria-label', ct('widget.chat_remove_image'));
        remove.addEventListener('click', () => {
          pendingChatImages.splice(index, 1);
          chatAttachmentError = '';
          renderPendingChatAttachments();
        });
        item.append(preview, remove);
        chatPendingImages.appendChild(item);
      }
      chatPendingImages.style.display = pendingChatImages.length ? 'flex' : 'none';

      chatPendingFiles.innerHTML = '';
      for (const [index, file] of pendingChatFiles.entries()) {
        chatPendingFiles.appendChild(createChatFileChip(file, {
          removable:true,
          onRemove:() => {
            pendingChatFiles.splice(index, 1);
            chatAttachmentError = '';
            renderPendingChatAttachments();
          },
        }));
      }
      chatPendingFiles.style.display = pendingChatFiles.length ? 'flex' : 'none';
      chatAttachButton.disabled = chatRequestInFlight || chatSendPreparing || chatQueuedFileCount > 0;

      const isError = Boolean(chatAttachmentError || (chatHistoryPersistenceFailed && !chatPdfOcrRetryActive));
      chatInputStatus.dataset.error = String(isError);
      if (chatAttachmentError) chatInputStatus.textContent = chatAttachmentError;
      else if (chatPdfOcrRetryActive) chatInputStatus.textContent = ct('widget.chat_pdf_ocr_retry');
      else if (chatHistoryPersistenceFailed) chatInputStatus.textContent = ct('widget.chat_history_save_failed');
      else if (chatQueuedImageCount > 0) chatInputStatus.textContent = ct('widget.chat_adding_image');
      else if (chatQueuedFileCount > 0) chatInputStatus.textContent = ct('widget.chat_adding_file');
      else if (chatRequestInFlight && chatRequestFileCount > 0) chatInputStatus.textContent = ct('widget.chat_analyzing_files');
      else if (chatRequestInFlight && chatRequestImageCount > 1) chatInputStatus.textContent = ct('widget.chat_analyzing_images').replace('{count}', String(chatRequestImageCount));
      else if (chatRequestInFlight && chatRequestImageCount === 1) chatInputStatus.textContent = ct('widget.chat_analyzing_image');
      else if (chatRequestInFlight) chatInputStatus.textContent = ct('widget.sending');
      else chatInputStatus.textContent = '';
      chatInputStatus.style.display = chatInputStatus.textContent ? 'block' : 'none';
    }

    function chatModelSupportsImages(modelId) {
      const model = chatCatalog.find(item => item.id === modelId);
      const architecture = model?.architecture;
      const inputModalities = architecture?.input_modalities;
      if (Array.isArray(inputModalities) && inputModalities.length) {
        return inputModalities.some(value => String(value).toLowerCase() === 'image');
      }
      const modality = String(architecture?.modality || '');
      if (modality) return (modality.split('->')[0] || modality).toLowerCase().includes('image');
      return null;
    }

    function queuePastedChatImages(files) {
      if (pendingChatFiles.length || chatQueuedFileCount > 0) {
        chatAttachmentError = ct('widget.chat_file_image_mix');
        renderPendingChatAttachments();
        return chatImageProcessing;
      }
      const available = Math.max(0, MAX_PENDING_CHAT_IMAGES - pendingChatImages.length - chatQueuedImageCount);
      const accepted = files.slice(0, available);
      if (!accepted.length) {
        chatAttachmentError = ct('widget.chat_image_limit');
        renderPendingChatAttachments();
        return chatImageProcessing;
      }
      if (accepted.length < files.length) chatAttachmentError = ct('widget.chat_image_limit');
      else chatAttachmentError = '';
      const pasteEpoch = chatImagePasteEpoch;
      chatQueuedImageCount += accepted.length;
      renderPendingChatAttachments();

      chatImageProcessing = chatImageProcessing.then(async () => {
        for (const file of accepted) {
          try {
            const image = await optimizeChatImageFile(file);
            if (pasteEpoch === chatImagePasteEpoch && pendingChatImages.length < MAX_PENDING_CHAT_IMAGES) pendingChatImages.push(image);
          } catch (error) {
            if (pasteEpoch === chatImagePasteEpoch) {
              chatAttachmentError = String(error?.message || '').includes('too large')
                ? ct('widget.chat_image_too_large')
                : ct('widget.chat_image_paste_failed');
            }
          } finally {
            if (pasteEpoch === chatImagePasteEpoch) chatQueuedImageCount = Math.max(0, chatQueuedImageCount - 1);
            renderPendingChatAttachments();
          }
        }
      }).catch(() => {
        if (pasteEpoch === chatImagePasteEpoch) {
          chatQueuedImageCount = 0;
          chatAttachmentError = ct('widget.chat_image_paste_failed');
          renderPendingChatAttachments();
        }
      });
      return chatImageProcessing;
    }

    function readSelectedChatFile(file, descriptor) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const raw = String(reader.result || '');
          const comma = raw.indexOf(',');
          if (comma < 0) { reject(new Error(ct('widget.chat_file_read_failed'))); return; }
          const dataUrl = `data:${descriptor.mimeType};base64,${raw.slice(comma + 1)}`;
          const normalized = sanitizeChatFile({
            kind:'file',
            filename:descriptor.filename,
            extension:descriptor.extension,
            mimeType:descriptor.mimeType,
            dataUrl,
            bytes:file.size,
            ts:Date.now(),
          });
          if (!normalized) { reject(new Error(ct('widget.chat_file_read_failed'))); return; }
          resolve(normalized);
        };
        reader.onerror = () => reject(new Error(ct('widget.chat_file_read_failed')));
        reader.readAsDataURL(file);
      });
    }

    function queueSelectedChatFiles(files) {
      if (pendingChatImages.length || chatQueuedImageCount > 0) {
        chatAttachmentError = ct('widget.chat_file_image_mix');
        renderPendingChatAttachments();
        return chatFileProcessing;
      }
      const available = Math.max(0, MAX_PENDING_CHAT_FILES - pendingChatFiles.length - chatQueuedFileCount);
      const accepted = [];
      let projectedBytes = pendingChatFiles.reduce((sum, file) => sum + file.bytes, 0) + chatQueuedFileBytes;
      let validationError = '';
      for (const file of files) {
        const descriptor = getChatAttachmentDescriptor(file);
        if (!descriptor || descriptor.kind !== 'file') { validationError ||= ct('widget.chat_file_unsupported'); continue; }
        if (file.size > MAX_CHAT_FILE_BYTES) { validationError ||= ct('widget.chat_file_too_large'); continue; }
        if (accepted.length >= available) { validationError ||= ct('widget.chat_file_limit'); continue; }
        if (projectedBytes + file.size > MAX_TOTAL_PENDING_CHAT_FILE_BYTES) { validationError ||= ct('widget.chat_files_total_too_large'); continue; }
        accepted.push({ file, descriptor });
        projectedBytes += file.size;
      }
      if (!accepted.length) {
        chatAttachmentError = validationError || ct('widget.chat_file_limit');
        renderPendingChatAttachments();
        return chatFileProcessing;
      }
      chatAttachmentError = validationError;
      const selectionEpoch = chatFileSelectionEpoch;
      chatQueuedFileCount += accepted.length;
      chatQueuedFileBytes += accepted.reduce((sum, item) => sum + item.file.size, 0);
      renderPendingChatAttachments();
      chatFileProcessing = chatFileProcessing.then(async () => {
        for (const { file, descriptor } of accepted) {
          try {
            const normalized = await readSelectedChatFile(file, descriptor);
            if (selectionEpoch === chatFileSelectionEpoch && pendingChatFiles.length < MAX_PENDING_CHAT_FILES) pendingChatFiles.push(normalized);
          } catch (error) {
            if (selectionEpoch === chatFileSelectionEpoch) chatAttachmentError = error?.message || ct('widget.chat_file_read_failed');
          } finally {
            if (selectionEpoch === chatFileSelectionEpoch) {
              chatQueuedFileCount = Math.max(0, chatQueuedFileCount - 1);
              chatQueuedFileBytes = Math.max(0, chatQueuedFileBytes - file.size);
            }
            renderPendingChatAttachments();
          }
        }
      }).catch(() => {
        if (selectionEpoch === chatFileSelectionEpoch) {
          chatQueuedFileCount = 0;
          chatQueuedFileBytes = 0;
          chatAttachmentError = ct('widget.chat_file_read_failed');
          renderPendingChatAttachments();
        }
      });
      return chatFileProcessing;
    }

    chatAttachButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (chatRequestInFlight) return;
      beginChatFilePicker();
      chatFileInput.value = '';
      try { chatFileInput.click(); }
      catch { finishChatFilePicker(); }
    });
    chatFileInput.addEventListener('click', event => {
      event.stopPropagation();
      event.stopImmediatePropagation();
    });
    chatFileInput.addEventListener('cancel', event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      finishChatFilePicker();
    });
    chatFileInput.addEventListener('change', async event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      clearTimeout(chatFilePickerReturnTimer);
      clearTimeout(chatFilePickerReleaseTimer);
      chatFilePickerGraceUntil = 0;
      chatFilePickerActive = true;
      chatFilePickerProcessing = true;
      keepChatWindowOpen();
      try {
        const selected = [...(chatFileInput.files || [])];
        chatFileInput.value = '';
        if (!selected.length) return;
        const descriptors = selected.map(getChatAttachmentDescriptor);
        if (descriptors.some(item => !item)) {
          chatAttachmentError = ct('widget.chat_file_unsupported');
          renderPendingChatAttachments();
          return;
        }
        const kinds = new Set(descriptors.map(item => item.kind));
        if (kinds.size > 1) {
          chatAttachmentError = ct('widget.chat_file_image_mix');
          renderPendingChatAttachments();
          return;
        }
        if (descriptors[0].kind === 'image') {
          const normalizedImages = selected.map((file, index) => file.type === descriptors[index].mimeType
            ? file
            : new File([file], descriptors[index].filename, { type:descriptors[index].mimeType, lastModified:file.lastModified }));
          await queuePastedChatImages(normalizedImages);
        } else {
          await queueSelectedChatFiles(selected);
        }
      } finally {
        renderPendingChatAttachments();
        finishChatFilePicker();
      }
    });

    chatInput.addEventListener('paste', event => {
      const files = [...(event.clipboardData?.items || [])]
        .filter(item => item.kind === 'file' && /^image\/(png|jpe?g|webp)$/i.test(item.type || ''))
        .map(item => item.getAsFile())
        .filter(Boolean);
      if (!files.length) return;
      if (pendingChatFiles.length || chatQueuedFileCount > 0) {
        event.preventDefault();
        chatAttachmentError = ct('widget.chat_file_image_mix');
        renderPendingChatAttachments();
        return;
      }
      const clipboardText = String(event.clipboardData?.getData('text/plain') || '');
      if (/^data:image\//i.test(clipboardText.trim())) event.preventDefault();
      queuePastedChatImages(files);
    });

    renderPendingChatAttachments();

    async function ensureChatHistoryLoaded() {
      if (!chatHistoryReady) {
        chatHistoryReady = loadChatHistory()
          .then(history => { chatHistory = history; return history; })
          .catch(() => { chatHistory = []; return chatHistory; });
      }
      return chatHistoryReady;
    }

    function positionFloating(zone) {
      activeZone = zone === 'left' ? 'left' : 'right';
      const side = activeZone;
      edgeWrap.style.left  = side === 'left'  ? '20px' : 'auto';
      edgeWrap.style.right = side === 'right' ? '20px' : 'auto';
      applyFloatingLoaderSide(fl);
      if (me?.panel && me.panel.style.display !== 'none') me?.reposition?.();
      if (isMultiLoaderActive()) me?.placeLoader?.();
      if (!windowLayoutState.history) {
        const r = getDefaultRect('history');
        applyRect(historyPanel.panel, r, { width:r.width, height:r.height, minHeight:getWindowConfig('history').minH });
      }
      if (!windowLayoutState.chat) {
        const r = getDefaultRect('chat');
        applyRect(chatPanel.panel, r, { width:r.width, height:r.height, minHeight:getWindowConfig('chat').minH });
      }
      if (!windowLayoutState.multi && me?.panel) {
        const r = getDefaultRect('multi');
        applyRect(me.panel, r, { width:r.width, height:r.height, minHeight:getWindowConfig('multi').minH });
      }
      if (!windowLayoutState.logs) {
        const r = getDefaultRect('logs');
        applyRect(logsPanel.panel, r, { width:r.width, height:r.height, minHeight:getWindowConfig('logs').minH });
      }
      if (!windowLayoutState.answer && we?.widget) {
        const r = getDefaultRect('answer');
        applyAnswerFrame(we.widget, { x:r.x, y:r.y, width:r.width }, { width:r.width || getWindowConfig('answer').width });
        we.widget.style.height = 'auto'; we.widget.style.minHeight = '0'; we.widget.style.maxHeight = '400px';
      }
    }

    function bindDragResize(winKey, panelObj, dragHandle, isPinned = () => false) {
      const el = panelObj.panel || panelObj.widget || panelObj;
      if (!el || !dragHandle) return;

      const cfg  = getWindowConfig(winKey);
      const minW = cfg.minW || 160;
      const minH = cfg.minH || 36;

      el.style.resize = 'none';
      el.style.overflow = 'visible';

      if (!el.dataset.resizeHandleAttached) {
        el.dataset.resizeHandleAttached = 'true';
        const handles = [
          { dir:'n',  style:{ top:'-4px',    left:'10px',  right:'10px',  height:'8px',  cursor:'ns-resize'   } },
          { dir:'s',  style:{ bottom:'-4px', left:'10px',  right:'10px',  height:'8px',  cursor:'ns-resize'   } },
          { dir:'w',  style:{ left:'-4px',   top:'10px',   bottom:'10px', width:'8px',   cursor:'ew-resize'   } },
          { dir:'e',  style:{ right:'-4px',  top:'10px',   bottom:'10px', width:'8px',   cursor:'ew-resize'   } },
          { dir:'nw', style:{ top:'-4px',    left:'-4px',  width:'12px',  height:'12px', cursor:'nwse-resize' } },
          { dir:'ne', style:{ top:'-4px',    right:'-4px', width:'12px',  height:'12px', cursor:'nesw-resize' } },
          { dir:'sw', style:{ bottom:'-4px', left:'-4px',  width:'12px',  height:'12px', cursor:'nesw-resize' } },
          { dir:'se', style:{ bottom:'-4px', right:'-4px', width:'12px',  height:'12px', cursor:'nwse-resize', borderRight:'2px solid #94a3b8', borderBottom:'2px solid #94a3b8', borderBottomRightRadius:'6px' } },
        ];

        let resizing = false, resizeDir = 'se';
        let resizeStartX = 0, resizeStartY = 0, resizeBaseW = 0, resizeBaseH = 0, resizeBaseLeft = 0, resizeBaseTop = 0;

        const startResize = dir => e => {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation();
          const r = el.getBoundingClientRect();
          resizing = true; resizeDir = dir;
          resizeStartX = e.clientX; resizeStartY = e.clientY;
          resizeBaseW = r.width; resizeBaseH = r.height;
          resizeBaseLeft = r.left; resizeBaseTop = r.top;
          el.style.width  = `${resizeBaseW}px`;
          el.style.height = `${resizeBaseH}px`;
          el.style.left   = `${resizeBaseLeft}px`;
          el.style.top    = `${resizeBaseTop}px`;
          el.style.right  = 'auto';
          el.style.bottom = 'auto';
        };

        for (const h of handles) {
          const node = document.createElement('div');
          Object.assign(node.style, { position:'absolute', zIndex:'3', opacity:'0', ...h.style });
          if (h.dir === 'se') node.style.opacity = '1';
          node.dataset.dir = h.dir;
          node.addEventListener('mousedown', startResize(h.dir));
          el.appendChild(node);
        }

        addManagedListener(document, 'mousemove', e => {
          if (!resizing) return;
          const dx = e.clientX - resizeStartX, dy = e.clientY - resizeStartY;
          let nextLeft = resizeBaseLeft, nextTop = resizeBaseTop, nextW = resizeBaseW, nextH = resizeBaseH;
          if (resizeDir.includes('e')) nextW = resizeBaseW + dx;
          if (resizeDir.includes('s')) nextH = resizeBaseH + dy;
          if (resizeDir.includes('w')) { nextW = resizeBaseW - dx; nextLeft = resizeBaseLeft + dx; }
          if (resizeDir.includes('n')) { nextH = resizeBaseH - dy; nextTop  = resizeBaseTop  + dy; }
          if (nextW < minW) { if (resizeDir.includes('w')) nextLeft -= (minW - nextW); nextW = minW; }
          if (nextH < minH) { if (resizeDir.includes('n')) nextTop  -= (minH - nextH); nextH = minH; }
          if (nextLeft < 0) { if (resizeDir.includes('w')) nextW += nextLeft; nextLeft = 0; }
          if (nextTop  < 0) { if (resizeDir.includes('n')) nextH += nextTop;  nextTop  = 0; }
          const maxH      = cfg.maxH ? Math.min(cfg.maxH, window.innerHeight - 8) : window.innerHeight - 8;
          const rightEdge = nextLeft + nextW, bottomEdge = nextTop + nextH;
          if (rightEdge  > window.innerWidth  - 8) nextW = Math.max(minW, window.innerWidth  - 8 - nextLeft);
          if (bottomEdge > window.innerHeight - 8) nextH = Math.max(minH, window.innerHeight - 8 - nextTop);
          nextH = clamp(nextH, minH, maxH);
          el.style.left = `${nextLeft}px`; el.style.top  = `${nextTop}px`;
          el.style.width = `${nextW}px`;   el.style.height = `${nextH}px`;
          el.style.maxHeight = 'calc(100vh - 8px)';
          if (winKey === 'answer' && we?.body) {
            const hH = we?.hdr?.offsetHeight || 36, tH = we?.tbar?.parentElement?.offsetHeight || 3;
            const bH = Math.max(0, nextH - hH - tH);
            we.body.style.height = `${bH}px`; we.body.style.maxHeight = `${bH}px`; we.body.style.overflowY = (we.body.scrollHeight > bH) ? 'auto' : 'visible';
          }
        }, { passive: true });

        addManagedListener(document, 'mouseup', () => {
          if (!resizing) return;
          resizing = false;
          if (winKey === 'answer') {
            answerUserResized = true;
            windowLayoutState.answerCustomized = true;
            if (we?.body) {
              const headerH = we?.hdr?.offsetHeight || 36, timerH = we?.tbar?.parentElement?.offsetHeight || 3;
              const totalH  = el.offsetHeight || 120;
              const bodyH   = Math.max(36, totalH - headerH - timerH);
              we.body.style.height = `${bodyH}px`; we.body.style.maxHeight = `${bodyH}px`; we.body.style.overflowY = 'auto';
            }
          }
          persistWindowRect(winKey, el);
          if (winKey === 'answer') {
            // Re-evaluate multi collision after answer is resized: multi's zone-bottom spawn
            // may now overlap the answer's new rect — fitToContent re-runs resolveMultiCollision.
            if (me?.panel?.style.display !== 'none') me?.reposition?.();
            if (isMultiLoaderActive()) me?.placeLoader?.();
          }
        });
      }

      /* drag */
      let dragging = false, startX = 0, startY = 0, baseLeft = 0, baseTop = 0;
      dragHandle.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        const forbidden = [panelObj.closeBtn, panelObj.pinBtn, hdrClose, hdrPin, modelSel].filter(Boolean);
        if (forbidden.some((node) => node === e.target || node.contains(e.target))) return;
        const r = el.getBoundingClientRect();
        dragging = true; startX = e.clientX; startY = e.clientY; baseLeft = r.left; baseTop = r.top;
        el.style.width  = `${r.width}px`;  el.style.height = `${r.height}px`;
        el.style.left   = `${baseLeft}px`; el.style.top    = `${baseTop}px`;
        el.style.right  = 'auto';          el.style.bottom = 'auto';
        e.preventDefault();
      });
      addManagedListener(document, 'mousemove', e => {
        if (!dragging) return;
        const w = el.offsetWidth  || (cfg.width  || 340);
        const h = el.offsetHeight || (cfg.height || 300);
        const left = clamp(baseLeft + (e.clientX - startX), 0, Math.max(0, window.innerWidth  - w));
        const top  = clamp(baseTop  + (e.clientY - startY), 0, Math.max(0, window.innerHeight - h));
        el.style.left = `${left}px`; el.style.top = `${top}px`;
      }, { passive: true });
      addManagedListener(document, 'mouseup', () => {
        if (!dragging) return;
        dragging = false;
        if (winKey === 'answer') {
          answerUserMoved = true;
          windowLayoutState.answerCustomized = true;
        }
        persistWindowRect(winKey, el);
        if (winKey === 'answer') {
          // Re-evaluate multi collision after answer is dragged onto multi's zone-bottom area.
          if (me?.panel?.style.display !== 'none') me?.reposition?.();
          if (isMultiLoaderActive()) me?.placeLoader?.();
        }
      });

      /* debounced ResizeObserver */
      let roPersistTimer = null;
      const ro = new ResizeObserver(() => {
        if (winKey === 'answer') return;
        clearTimeout(roPersistTimer);
        roPersistTimer = setTimeout(() => { persistWindowRect(winKey, el); }, 150);
      });
      ro.observe(el);
      addCleanup(() => { ro.disconnect(); clearTimeout(roPersistTimer); });
    }

    function renderHistoryPanel() {
      historyPanel.body.innerHTML = '';
      if (!ansHistory.length) { historyPanel.body.innerHTML = `<div style="color:#64748b">${ct('widget.history_empty')}</div>`; return; }
      [...ansHistory].reverse().forEach((item, i) => {
        const date  = new Date(item.ts || Date.now());
        const stamp = Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '—';
        const card  = document.createElement('div');
        card.style.cssText = 'padding:8px;border:1px solid var(--qm-border,#e2e8f0);border-radius:10px;margin-bottom:8px;background:var(--qm-surface,#f8fafc);transition:transform 0.22s cubic-bezier(0.34,1.26,0.64,1),box-shadow 0.22s ease,border-color 0.22s ease,background 0.22s ease;';
        card.style.animation = `qm-in 0.24s cubic-bezier(0.22,1,0.36,1) ${i * 0.04}s both`;
        card.addEventListener('mouseenter', () => { card.style.transform='translateY(-2px)'; card.style.boxShadow='0 8px 24px rgba(37,99,235,0.12),0 0 0 1px rgba(147,197,253,0.22)'; card.style.borderColor='rgba(147,197,253,0.75)'; card.style.background='var(--qm-surface-2,rgba(255,255,255,0.85))'; });
        card.addEventListener('mouseleave', () => { card.style.transform=''; card.style.boxShadow=''; card.style.borderColor='var(--qm-border,#e2e8f0)'; card.style.background='var(--qm-surface,#f8fafc)'; });
        card.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;"><div style="font-weight:600;">User query</div><div style="font-size:11px;color:#64748b;">${stamp}</div></div><div style="margin-bottom:6px;color:#334155">${(item.query||'—').replace(/</g,'&lt;')}</div><div style="font-size:11px;color:#64748b;margin-bottom:4px;">Model: ${(item.model||'—').replace(/</g,'&lt;')}</div><div><b>Model answer</b></div><div>${renderMarkdown(item.answer||'')}</div>`;
        historyPanel.body.appendChild(card);
      });
    }

    function setChatCopyButtonState(button, state = 'copy') {
      const copied = state === 'copied';
      button.dataset.state = state;
      button.title = copied ? ct('widget.copied') : ct('widget.chat_copy_answer');
      button.setAttribute('aria-label', button.title);
      button.innerHTML = copied
        ? '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    }

    function renderChat({ scrollToLatest = true } = {}) {
      chatMsgs.innerHTML = '';
      for (const [i, m] of chatHistory.entries()) {
        const wrap   = document.createElement('div');
        wrap.dataset.chatRole = m.role;
        wrap.style.cssText = `display:flex;flex-direction:column;gap:4px;width:fit-content;max-width:90%;height:auto;min-height:0;align-self:start;${m.role==='user'?'margin-left:auto;align-items:flex-end;':'align-items:flex-start;'}`;
        const bubble = document.createElement('div');
        bubble.className = m.role === 'user' ? 'chat-bubble chat-bubble--user' : 'chat-bubble chat-bubble--assistant';
        bubble.style.cssText = 'display:block;padding:8px 10px;border-radius:10px;width:fit-content;max-width:100%;height:auto;min-height:0;box-sizing:border-box;';
        bubble.style.animation = `chat-msg-in 0.22s cubic-bezier(0.22,1,0.36,1) ${Math.min(i, 10) * 0.03}s both`;
        if (m.role === 'assistant') bubble.innerHTML = renderMarkdown(m.content);
        else {
          if (m.content) {
            const text = document.createElement('div');
            text.textContent = m.content;
            text.style.whiteSpace = 'pre-wrap';
            bubble.appendChild(text);
          }
          if (m.images?.length) {
            const images = document.createElement('div');
            images.className = 'chat-message-images';
            for (const image of m.images) {
              const previewButton = document.createElement('button');
              previewButton.type = 'button';
              previewButton.className = 'chat-message-image-button';
              previewButton.title = ct('widget.chat_preview_image');
              previewButton.setAttribute('aria-label', ct('widget.chat_preview_image'));
              const preview = document.createElement('img');
              preview.className = 'chat-message-image';
              preview.src = image.dataUrl;
              preview.alt = ct('widget.chat_attached_image');
              preview.loading = 'lazy';
              previewButton.addEventListener('click', () => openChatImagePreview(image));
              previewButton.appendChild(preview);
              images.appendChild(previewButton);
            }
            bubble.appendChild(images);
          }
          if (m.files?.length) {
            const files = document.createElement('div');
            files.className = 'chat-message-files';
            for (const file of m.files) files.appendChild(createChatFileChip(file));
            bubble.appendChild(files);
          }
        }
        wrap.appendChild(bubble);
        if (m.role === 'assistant') {
          const copyBtn = document.createElement('button');
          copyBtn.type = 'button';
          copyBtn.className = 'chat-copy-button';
          setChatCopyButtonState(copyBtn);
          copyBtn.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            const textToCopy = String(m.content || ''); if (!textToCopy) return;
            let copied = false;
            try { if (navigator?.clipboard?.writeText) { await navigator.clipboard.writeText(textToCopy); copied = true; } } catch {}
            if (!copied) { const ta = document.createElement('textarea'); ta.value = textToCopy; ta.style.cssText='position:fixed;opacity:0;'; document.body.appendChild(ta); ta.select(); try { copied = document.execCommand('copy'); } catch {} ta.remove(); }
            if (copied) {
              setChatCopyButtonState(copyBtn, 'copied');
              setTimeout(() => { if (copyBtn.isConnected) setChatCopyButtonState(copyBtn); }, 1200);
            } else {
              copyBtn.title = ct('widget.copy_failed');
              copyBtn.setAttribute('aria-label', copyBtn.title);
            }
          });
          bubble.appendChild(copyBtn);
        }
        chatMsgs.appendChild(wrap);
      }
      if (chatRequestError) {
        const errorRow = document.createElement('div');
        errorRow.dataset.chatError = 'true';
        errorRow.setAttribute('role', 'alert');
        errorRow.textContent = chatRequestError;
        errorRow.style.cssText = 'padding:7px 9px;border:1px solid rgba(252,165,165,0.8);border-radius:9px;background:rgba(254,242,242,0.88);color:#991b1b;font:11px/1.4 Inter,sans-serif;';
        chatMsgs.appendChild(errorRow);
      }
      if (scrollToLatest) scrollChatToLatest();
    }

    function sortChatModels(models) {
      const favSet = new Set(chatFavorites);
      return [...models].sort((a,b) => {
        const af = favSet.has(a.id) ? 0 : 1, bf = favSet.has(b.id) ? 0 : 1;
        if (af !== bf) return af - bf;
        return String(a.id).localeCompare(String(b.id));
      });
    }

    function setChatPickerVisible(visible) {
      chatModelPicker.style.display = visible ? 'grid' : 'none';
      if (!visible) chatModelList.style.display = 'none';
      chatChangeModelBtn.textContent = visible ? ct('widget.done') : ct('widget.change');
    }

    function resolveChatModelDisplayName(id) {
      if (!id) return '';
      const meta = chatCatalog.find(m => m.id === id);
      if (meta?.name) return meta.name;
      const displayNames = globalThis.TAModelsService?.MODEL_DISPLAY_NAMES;
      if (displayNames?.[id]) return displayNames[id];
      return shortName(id);
    }
    function applyChatModelCurrentLabel() {
      const value = String(chatModelInput.value || currentModel || '').trim();
      const displayName = resolveChatModelDisplayName(value);
      chatModelCurrent.textContent = displayName ? `Model: ${displayName}` : `Model: ${ct('widget.no_model_selected')}`;
      chatModelCurrent.title = value;
    }

    function renderChatModelDropdown(query) {
      const q    = String(query !== undefined ? query : (chatModelList.dataset.currentQuery ?? '')).trim();
      chatModelList.dataset.currentQuery = q;
      const base = globalThis.TAModelsService?.filterTextModels ? globalThis.TAModelsService.filterTextModels(chatCatalog) : chatCatalog;
      const ordered  = sortChatModels(base);
      const filtered = globalThis.TAModelsService?.searchModels
        ? globalThis.TAModelsService.searchModels(ordered, q)
        : ordered.filter(m => { if (!q) return true; const nq = q.toLowerCase(); return String(m.id||'').toLowerCase().includes(nq) || String(m.name||'').toLowerCase().includes(nq) || String(m.short_description||'').toLowerCase().includes(nq); });
      chatModelList.innerHTML = '';
      if (!chatCatalog.length) {
        const row = document.createElement('div'); row.style.cssText = 'padding:10px;color:#94a3b8;font-size:11px;text-align:center;'; row.textContent = ct('widget.loading_models'); chatModelList.appendChild(row);
      } else if (!filtered.length && !q) {
        const row = document.createElement('div'); row.style.cssText = 'padding:10px;color:#94a3b8;font-size:11px;text-align:center;'; row.textContent = ct('widget.no_models_found'); chatModelList.appendChild(row);
      }
      for (const model of filtered.slice(0, 80)) {
        const row  = document.createElement('div');
        row.className = 'chat-mdl-item';
        const main = document.createElement('div');
        main.className = 'chat-mdl-main';
        const nameEl = document.createElement('div');
        nameEl.className = 'chat-mdl-name';
        nameEl.textContent = model.name || model.id;
        nameEl.title = model.id;
        const idEl = document.createElement('div');
        idEl.className = 'chat-mdl-id';
        idEl.textContent = model.id;
        main.append(nameEl, idEl);
        const star = document.createElement('button'); star.type = 'button';
        const isFav = chatFavorites.includes(model.id);
        star.className = 'chat-mdl-star';
        star.dataset.fav = String(isFav);
        star.textContent = isFav ? '★' : '☆';
        star.title = isFav ? ct('widget.remove_fav') : ct('widget.add_fav');
        star.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
        star.addEventListener('click', async e => {
          e.preventDefault(); e.stopPropagation();
          chatFavorites = isFav ? chatFavorites.filter(x => x !== model.id) : [...new Set([...chatFavorites, model.id])];
          await window.TASettingsStorage?.setSettings({ model_favorites: chatFavorites, favorite_models: chatFavorites }).catch(() => {});
          renderChatModelDropdown();
        });
        row.addEventListener('mousedown', async e => {
          e.preventDefault();
          chatModelInput.value = model.id; currentModel = model.id;
          await window.TASettingsStorage?.setSettings({ widget_current_model: model.id, model_text: model.id }).catch(() => {});
          chatModelList.style.display = 'none'; setChatPickerVisible(false); applyChatModelCurrentLabel();
        });
        row.append(main, star); chatModelList.appendChild(row);
      }
      if (!filtered.length && q) {
        const row = document.createElement('div'); row.textContent = `${ct('widget.use_manually')}: ${query}`; row.style.cssText = 'padding:8px;color:#64748b;cursor:pointer';
        row.addEventListener('mousedown', async e => {
          e.preventDefault();
          const manual = String(query||'').trim(); if (!manual) return;
          chatModelInput.value = manual; currentModel = manual;
          await window.TASettingsStorage?.setSettings({ widget_current_model: manual, model_text: manual }).catch(() => {});
          chatModelList.style.display = 'none'; setChatPickerVisible(false); applyChatModelCurrentLabel();
        });
        chatModelList.appendChild(row);
      }
      chatModelList.style.display = (chatModelPicker.style.display !== 'none' && chatModelList.childElementCount) ? 'block' : 'none';
    }

    async function loadChatModels(forceRefresh = false) {
      try {
        const r = await safeSendMessage({ type:'GET_CHAT_MODELS', forceRefresh });
        chatCatalog = Array.isArray(r?.models) ? r.models : [];
        if (!chatCatalog.length && !forceRefresh) {
          const r2 = await safeSendMessage({ type:'GET_CHAT_MODELS', forceRefresh: true });
          chatCatalog = Array.isArray(r2?.models) ? r2.models : [];
        }
        const cfg = await window.TASettingsStorage?.getSettings().catch(() => null);
        chatFavorites = Array.isArray(cfg?.model_favorites) ? cfg.model_favorites : (Array.isArray(cfg?.favorite_models) ? cfg.favorite_models : []);
        renderChatModelDropdown('');
        const preferred = cfg?.widget_current_model || cfg?.model_text || cfg?.model_vision || currentModel || '';
        if (preferred) { chatModelInput.value = preferred; currentModel = preferred; }
        applyChatModelCurrentLabel();
        if (chatModelPicker.style.display !== 'none') renderChatModelDropdown();
      } catch (e) { console.error('Failed to load chat models', e); }
    }

    chatChangeModelBtn.addEventListener('click', () => {
      const nextVisible = chatModelPicker.style.display === 'none';
      setChatPickerVisible(nextVisible);
      if (nextVisible) { renderChatModelDropdown(''); chatModelInput.focus(); }
    });
    chatModelInput.addEventListener('focus', () => renderChatModelDropdown(''));
    chatModelInput.addEventListener('click', () => renderChatModelDropdown(''));
    chatModelInput.addEventListener('input', () => renderChatModelDropdown(chatModelInput.value));
    let chatModelBlurTimer = null;
    chatModelInput.addEventListener('keydown', async e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const manual = chatModelInput.value.trim(); if (!manual) return;
        currentModel = manual;
        await window.TASettingsStorage?.setSettings({ widget_current_model: manual, model_text: manual }).catch(() => {});
        chatModelList.style.display = 'none'; setChatPickerVisible(false); applyChatModelCurrentLabel();
      } else if (e.key === 'Escape') { chatModelList.style.display = 'none'; }
    });
    chatModelInput.addEventListener('blur', () => {
      chatModelBlurTimer = setTimeout(() => { chatModelList.style.display = 'none'; }, 120);
    });
    addCleanup(() => clearTimeout(chatModelBlurTimer));

    function syncChatFromSettings(cfg) {
      if (!cfg) return;
      chatFavorites = Array.isArray(cfg.model_favorites) ? cfg.model_favorites : (Array.isArray(cfg.favorite_models) ? cfg.favorite_models : chatFavorites);
      const preferred = cfg.widget_current_model || cfg.model_text || cfg.model_vision || currentModel || '';
      if (preferred) chatModelInput.value = preferred;
      applyChatModelCurrentLabel();
      if (chatModelPicker.style.display !== 'none') renderChatModelDropdown();
      // Re-apply localized strings in case language changed after widget creation
      chatInput.placeholder = ct('widget.chat_write_message');
      chatClearBtn.textContent = ct('widget.chat_clear_history');
      chatImagePreviewClose.title = ct('widget.chat_close_preview');
      chatImagePreviewClose.setAttribute('aria-label', ct('widget.chat_close_preview'));
      chatImagePreviewImage.alt = ct('widget.chat_attached_image');
      if (!chatSend.disabled) chatSend.textContent = ct('widget.chat_send');
      chatAttachButton.title = ct('widget.chat_attach_file');
      chatAttachButton.setAttribute('aria-label', ct('widget.chat_attach_file'));
      renderPendingChatAttachments();
    }

    function isAnyInteractiveWindowVisible() {
      return WindowManager.isWindowVisible('answer') ||
             WindowManager.isWindowVisible('history') ||
             WindowManager.isWindowVisible('chat') ||
             WindowManager.isWindowVisible('multi') ||
             WindowManager.isWindowVisible('logs');
    }

    function isRoundLaunchersBlockedByPriority() {
      return isAnswerLoaderActive() || isMultiLoaderActive() || isGptChatLoaderActive() || isAnyInteractiveWindowVisible();
    }

    function isPointerInLauncherTriggerZone() {
      const nearBottom = lastPointer.y >= window.innerHeight - 56;
      const inZone = activeZone === 'left'
        ? lastPointer.x >= 0 && lastPointer.x <= 220
        : lastPointer.x >= window.innerWidth - 220;
      return nearBottom && inZone;
    }

    function forceHideEdge() {
      edgeWrap.style.display = 'none'; edgeWrap.style.opacity = '0'; edgeWrap.style.transform = 'scale(0.92)'; edgeWrap.style.pointerEvents = 'none';
    }

    function setEdgeVisible(v) {
      if (v && extensionEnabled) {
        edgeWrap.style.display = 'flex'; edgeWrap.offsetHeight;
        edgeWrap.style.opacity = '1'; edgeWrap.style.transform = 'scale(1)'; edgeWrap.style.pointerEvents = 'auto';
      } else {
        edgeWrap.style.opacity = '0'; edgeWrap.style.transform = 'scale(0.92)'; edgeWrap.style.pointerEvents = 'none';
        setTimeout(() => { if (edgeWrap.style.opacity === '0') edgeWrap.style.display = 'none'; }, 300);
      }
    }

    function refreshLauncherVisibility() {
      if (isRoundLaunchersBlockedByPriority()) { forceHideEdge(); return; }
      setEdgeVisible(isPointerInLauncherTriggerZone());
    }

    const updateLauncherPointer = e => {
      const x = Number(e?.clientX), y = Number(e?.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      lastPointer = { x, y };
      refreshLauncherVisibility();
    };

    // Capture phase + pointer events so hover activation works immediately after page load,
    // even on pages that intercept or delay bubbling mousemove handlers.
    addManagedListener(window, 'pointermove', updateLauncherPointer, { passive:true, capture:true });
    addManagedListener(document, 'mousemove',  updateLauncherPointer, { passive:true, capture:true });
    // pointerover fires when the browser initialises cursor state over the new DOM after a
    // page reload — even with zero physical movement.  This seeds lastPointer with real
    // coordinates so isPointerInLauncherTriggerZone() can return true immediately, without
    // waiting for the first click or first mouse-move event.
    addManagedListener(document, 'pointerover', updateLauncherPointer, { passive:true, capture:true });

    historyFab.addEventListener('click', () => {
      if (!canOpenHistoryWindow()) { hideLowerPriorityWindows('history_blocked_by_active_flow'); return; }
      renderHistoryPanel();
      WindowManager.showWindow('history', { restore:true, display:'flex', startTimer:true });
      WindowManager.hideWindow('chat', { persist:true, stopTimer:true });
      setEdgeVisible(false);
    });

    chatFab.addEventListener('click', async () => {
      if (!canOpenChatWindow()) { hideLowerPriorityWindows('chat_blocked_by_answer_flow'); return; }
      await Promise.all([loadChatModels(), ensureChatHistoryLoaded()]);
      setChatPickerVisible(false); applyChatModelCurrentLabel(); renderChat({ scrollToLatest:false }); renderPendingChatAttachments();
      chatClosedManuallyDuringRequest = false;
      showChatWindowAtLatest({ restore:true, startTimer:!chatRequestInFlight });
      WindowManager.hideWindow('history', { persist:true, stopTimer:true });
      setEdgeVisible(false);
    });

    logsFab.addEventListener('click', () => {
      WindowManager.showWindow('logs', { restore:true, display:'flex', startTimer:false });
      _QML?.renderPanel();
      _QML?.installUpdate();
      setEdgeVisible(false);
    });

    chatClearBtn.addEventListener('click', async () => {
      chatClearEpoch += 1;
      chatImagePasteEpoch += 1;
      chatQueuedImageCount = 0;
      chatImageProcessing = Promise.resolve();
      chatFileSelectionEpoch += 1;
      chatQueuedFileCount = 0;
      chatQueuedFileBytes = 0;
      chatFileProcessing = Promise.resolve();
      pendingChatImages = [];
      pendingChatFiles = [];
      chatInput.value = '';
      chatFileInput.value = '';
      chatAttachmentError = '';
      chatHistory = [];
      chatRequestError = '';
      chatPdfOcrRetryActive = false;
      chatContactSheetCache.clear();
      closeChatImagePreview();
      renderChat();
      renderPendingChatAttachments();
      await clearChatHistory();
      renderPendingChatAttachments();
    });

    function getChatCompletionError(response) {
      if (response?.ok && String(response.answer || '').trim()) return '';
      if (response?.errorCode === 'CHAT_PDF_OCR_TIMEOUT') return ct('widget.chat_pdf_ocr_timeout');
      if (response?.errorCode === 'CHAT_FILE_TIMEOUT') return ct('widget.chat_file_timeout');
      if (response?.errorCode === 'CHAT_FILE_REJECTED') return ct('widget.chat_file_rejected');
      if (response?.errorCode === 'CHAT_FILE_INVALID') return ct('widget.chat_file_unsupported');
      if (response?.errorCode === 'CHAT_IMAGE_TIMEOUT') return ct('widget.chat_image_timeout');
      return response?.error || ct('widget.cant_get_answer');
    }

    const sendChatMessage = async () => {
      if (chatRequestInFlight || chatSendPreparing) return;
      chatSendPreparing = true;
      keepChatWindowOpen();
      scrollChatToLatest();
      try {
        await Promise.all([chatImageProcessing, chatFileProcessing]);
      } catch (error) {
        chatRequestError = `${ct('widget.error_prefix')}${error?.message || ct('widget.chat_file_read_failed')}`;
        renderChat();
        keepChatWindowOpen();
        return;
      } finally {
        chatSendPreparing = false;
      }
      if (chatRequestInFlight) return;
      const text = chatInput.value.trim();
      const images = pendingChatImages.map(image => ({ ...image }));
      const files = pendingChatFiles.map(file => ({ ...file }));
      const hasPdf = chatFilesIncludePdf(files);
      if (!text && !images.length && !files.length) return;
      if (images.length && files.length) {
        chatAttachmentError = ct('widget.chat_file_image_mix');
        renderPendingChatAttachments();
        return;
      }
      const selectedModel = chatModelInput.value.trim();
      if (!selectedModel) { setChatPickerVisible(true); return; }
      if (images.length && chatModelSupportsImages(selectedModel) === false) {
        chatAttachmentError = ct('widget.chat_model_no_images');
        renderPendingChatAttachments();
        return;
      }
      chatAttachmentError = '';
      chatRequestError = '';
      chatRequestInFlight = true;
      chatRequestImageCount = images.length;
      chatRequestFileCount = files.length;
      chatClosedManuallyDuringRequest = false;
      const requestEpoch = chatClearEpoch;
      gptChatLoaderActive = true;
      keepChatWindowOpen();
      hideLowerPriorityWindows('gpt_chat_loader_start');
      refreshLauncherVisibility();
      chatSend.disabled = true;
      const prevLabel = chatSend.textContent; chatSend.textContent = ct('widget.sending');
      renderPendingChatAttachments();
      try {
        await ensureChatHistoryLoaded();
        chatHistory = await appendChatHistory(chatHistory, { role:'user', content:text, images, files, ts:Date.now() });
        renderChat();
        chatInput.value = '';
        pendingChatImages = [];
        pendingChatFiles = [];
        renderPendingChatAttachments();
        keepChatWindowOpen();
        const requestMessages = await getChatContextForRequest(chatHistory);
        const courseResult = await getCoursePackRequestContext(text, 'chat');
        const groundedRequestMessages = injectCourseContextIntoChatMessages(requestMessages, courseResult.context);
        let resp = await safeSendMessage({ type:'CHAT_COMPLETE', payload:{ model: selectedModel, messages:groundedRequestMessages } });
        let requestError = getChatCompletionError(resp);
        if (requestError) throw new Error(requestError);
        if (requestEpoch !== chatClearEpoch) return;
        if (hasPdf && looksLikePdfParseFailure(resp.answer)) {
          chatPdfOcrRetryActive = true;
          renderPendingChatAttachments();
          keepChatWindowOpen();
          resp = await safeSendMessage({
            type:'CHAT_COMPLETE',
            payload:{ model:selectedModel, messages:groundedRequestMessages, plugins:CHAT_PDF_OCR_PLUGINS },
          });
          requestError = getChatCompletionError(resp);
          if (requestError) throw new Error(requestError);
          if (looksLikePdfParseFailure(resp.answer)) throw new Error(ct('widget.chat_pdf_ocr_failed'));
        }
        if (requestEpoch !== chatClearEpoch) return;
        chatHistory = await appendChatHistory(chatHistory, { role:'assistant', content:resp.answer, model:resp.model || selectedModel, ts:Date.now() });
        renderChat();
        keepChatWindowOpen();
        hideLowerPriorityWindows('gpt_chat_window_visible');
      } catch (e) {
        if (requestEpoch !== chatClearEpoch) return;
        chatRequestError = `${ct('widget.error_prefix')}${e?.message || ct('widget.cant_get_answer')}`;
        renderChat();
        keepChatWindowOpen();
        hideLowerPriorityWindows('gpt_chat_window_visible');
      } finally {
        chatRequestInFlight = false;
        chatRequestImageCount = 0;
        chatRequestFileCount = 0;
        chatPdfOcrRetryActive = false;
        gptChatLoaderActive = false;
        renderPendingChatAttachments();
        refreshLauncherVisibility();
        chatSend.disabled = false; chatSend.textContent = prevLabel;
        if (requestEpoch === chatClearEpoch) keepChatWindowOpen();
        chatClosedManuallyDuringRequest = false;
      }
    };

    chatSend.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      keepChatWindowOpen();
      void sendChatMessage();
    });
    chatInput.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      keepChatWindowOpen();
      void sendChatMessage();
    });
    addManagedListener(window, 'keydown', event => {
      const path = event.composedPath ? event.composedPath() : [];
      if (event.key !== 'Enter' || event.target === chatInput || path.includes(chatInput)) return;
      const pickerGraceActive = chatFilePickerActive
        || chatFilePickerProcessing
        || Date.now() < chatFilePickerGraceUntil;
      if (!pickerGraceActive || chatPanel.panel.style.display === 'none') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      try { chatInput.focus({ preventScroll:true }); } catch { chatInput.focus(); }
      if (event.isComposing || event.ctrlKey || event.metaKey) return;
      if (event.shiftKey) {
        const start = Number.isFinite(chatInput.selectionStart) ? chatInput.selectionStart : chatInput.value.length;
        const end = Number.isFinite(chatInput.selectionEnd) ? chatInput.selectionEnd : start;
        chatInput.setRangeText('\n', start, end, 'end');
        return;
      }
      keepChatWindowOpen();
      void sendChatMessage();
    }, true);

    const setZone = zone => { activeZone = zone; positionFloating(zone); refreshLauncherVisibility(); };
    setZone(activeZone);
    applyWidgetPinnedState();
    historyPanel.applyPinUi();
    chatPanel.applyPinUi();
    applyChatModelCurrentLabel();
    refreshLauncherVisibility();
    setChatPickerVisible(false);

    bindDragResize('answer',  { panel: widget, closeBtn: hdrClose, pinBtn: hdrPin }, hdr, () => widgetPinned);
    bindDragResize('history', historyPanel, historyPanel.hdr, () => historyPanel.timer?.pinned);
    bindDragResize('chat',    chatPanel,    chatPanel.hdr,    () => chatPanel.timer?.pinned);
    bindDragResize('logs',    logsPanel,    logsPanel.hdr,    () => logsPanel.timer?.pinned);

    addManagedListener(document, 'mousedown', e => {
      if (!extensionEnabled) return;
      const path = e.composedPath ? e.composedPath() : [];
      const answerPanelEl  = WindowManager.getPanel('answer');
      const historyPanelEl = WindowManager.getPanel('history');
      const chatPanelEl    = WindowManager.getPanel('chat');
      const multiPanelEl   = WindowManager.getPanel('multi');
      const inAnswer  = Boolean(answerPanelEl  && path.includes(answerPanelEl));
      const inHistory = Boolean(historyPanelEl && path.includes(historyPanelEl));
      const inChat    = Boolean(chatPanelEl    && path.includes(chatPanelEl));
      const inMulti   = Boolean(multiPanelEl   && path.includes(multiPanelEl));
      if (!inHistory && historyPanelEl && historyPanelEl.style.display !== 'none' && !WindowManager.isWindowPinned('history') && !historyPanelEl.matches(':hover')) WindowManager.hideWindow('history', { persist:true, stopTimer:true });
      if (!inChat && !chatRequestInFlight && !chatSendPreparing && !chatFilePickerActive && !chatFilePickerProcessing && chatPanelEl && chatPanelEl.style.display !== 'none' && !WindowManager.isWindowPinned('chat') && !chatPanelEl.matches(':hover')) WindowManager.hideWindow('chat', { persist:true, stopTimer:true });
      if (!inMulti   && multiPanelEl   && multiPanelEl.style.display   !== 'none' && !WindowManager.isWindowPinned('multi')   && !multiPanelEl.matches(':hover'))   WindowManager.hideWindow('multi',   { persist:true, stopTimer:true });
      if (!inAnswer && answerPanelEl && answerPanelEl.style.display !== 'none' && !WindowManager.isWindowPinned('answer') && !answerPanelEl.matches(':hover') && !inHistory && !inChat && !inMulti) {
        WindowManager.hideWindow('answer', { persist:true, stopTimer:true });
        refreshLauncherVisibility();
      }
    }, true);

    hdrClose.addEventListener('click', () => {
      WindowManager.hideWindow('answer', { persist:true, stopTimer:true });
      refreshLauncherVisibility();
    });
    hdrPin.addEventListener('click', () => toggleWidgetPin());
    widget.addEventListener('mouseenter', () => { isHovered = true;  timerStop(); updateWidgetTimerBar(1); });
    widget.addEventListener('mouseleave', () => { isHovered = false; timerStart(WIDGET_TIMER_MS); });

    function updateNav() {
      const cnt = ansHistory.length;
      if (cnt <= 1) { nav.classList.remove('vis'); return; }
      nav.classList.add('vis');
      const di = histIdx === -1 ? cnt - 1 : histIdx;
      navLbl.textContent = `${di + 1}/${cnt}`;
      prevBtn.disabled = di <= 0;
      nextBtn.disabled = histIdx === -1;
    }
    function showEntry(idx) {
      const e = ansHistory[idx]; if (!e) return;
      const normalized = normalizeAnswerText(e.answer);
      body.innerHTML = renderMarkdown(normalized);
      body.prepend(loader); loader.style.display = 'none';
      body.style.maxHeight = ''; body.style.overflowY = '';
      updateAnswerLayout();
      if (e.model) { modelSel.value = e.model; currentModel = e.model; }
    }
    prevBtn.addEventListener('click', () => { const c = histIdx===-1?ansHistory.length-1:histIdx; histIdx=Math.max(0,c-1); showEntry(histIdx); updateNav(); });
    nextBtn.addEventListener('click', () => { const n=histIdx+1; if(n>=ansHistory.length-1){histIdx=-1;showEntry(ansHistory.length-1);}else{histIdx=n;showEntry(n);} updateNav(); });

    rowBtn.addEventListener('click', () => applyWidgetSide(widgetSide === 'left' ? 'right' : 'left'));

    function saveTimer() { window.TASettingsStorage?.setSettings({ widget_timer_ms: WIDGET_TIMER_MS }).catch(() => {}); }
    tMinus.addEventListener('click', () => { WIDGET_TIMER_MS = Math.max(1000, WIDGET_TIMER_MS - 1000); timerText.textContent = Math.round(WIDGET_TIMER_MS/1000)+ct('popup.seconds_abbr'); saveTimer(); });
    tPlus.addEventListener('click',  () => { WIDGET_TIMER_MS = Math.min(60000,WIDGET_TIMER_MS + 1000); timerText.textContent = Math.round(WIDGET_TIMER_MS/1000)+ct('popup.seconds_abbr'); saveTimer(); });

    modelSel.addEventListener('change', async () => {
      currentModel = modelSel.value; lastSettingsModel = currentModel;
      window.TASettingsStorage?.setSettings({ widget_current_model: currentModel, model_text: currentModel }).catch(() => {});
      we?.syncChatFromSettings?.({ widget_current_model: currentModel, model_text: currentModel });
      const q = getQuestionText();
      if (q) await runAnswerFlow('model-switch', 'answer');
    });

    multiBtn.addEventListener('click', () => runMultiCheck({ force: true }));
    settingsBtn.addEventListener('click', () => toggleSettings());

    we = { widget, hdr, body, loader, fl, nav, navLbl, prevBtn, nextBtn, modelSel, rowBtn, rowLbl, timerVal, timerText, tbar, updateNav, showEntry, renderHistoryPanel, edgeWrap, setZone, syncChatFromSettings, refreshLauncherVisibility, pinBtn: hdrPin, historyPanel, chatPanel, logsFab, logsPanel };

    /* Create the answer window timer using unified TimerController from qm-shared.js.
     * onTick: updates the timer bar visual
     * onExpire: auto-hides the answer window (if not hovered)
     * getPinned: suppresses ticking while pinned
     * getVisible: suppresses ticking when window is hidden or destroyed */
    answerTimer = new window.__QM.TimerController({
      onTick:     updateWidgetTimerBar,
      onExpire:   () => { if (!isHovered) WindowManager.hideWindow('answer', { persist: true, stopTimer: true }); },
      getPinned:  () => widgetPinned,
      getVisible: () => !isDestroyed && we?.widget?.style.display !== 'none',
    });

    return we;
  }

  /* ═══ VISIBILITY HELPERS ═══════════════════════════════════════════ */
  function isAnswerLoaderActive() {
    const visible = el => Boolean(el && el.isConnected && getComputedStyle(el).display !== 'none');
    return visible(we?.loader) || visible(we?.fl);
  }
  function isMultiLoaderActive() {
    const ml = me?.mloader;
    return Boolean(ml && ml.isConnected && getComputedStyle(ml).display !== 'none');
  }
  function isAnswerWindowActive()  { return WindowManager.isWindowVisible('answer'); }
  function isAnswerFlowActive()    { return isAnswerLoaderActive() || isAnswerWindowActive(); }
  function isGptChatLoaderActive() { return Boolean(gptChatLoaderActive); }
  function isChatFilePickerActive() { return Boolean(chatFilePickerActive); }
  function isGptChatWindowActive() { return WindowManager.isWindowVisible('chat'); }
  function isGptChatFlowActive()   { return isGptChatLoaderActive() || isChatFilePickerActive() || isGptChatWindowActive(); }

  function hideLowerPriorityWindows(reason = '') {
    if (isAnswerFlowActive()) {
      WindowManager.hideWindow('history', { persist:true, stopTimer:true });
      WindowManager.hideWindow('chat',    { persist:true, stopTimer:true });
      if (settingsEl?.pop) { settingsEl.pop.style.display = 'none'; settingsVisible = false; }
      if (we?.edgeWrap) { we.edgeWrap.style.opacity='0'; we.edgeWrap.style.pointerEvents='none'; we.edgeWrap.style.display='none'; }
      return;
    }
    if (isGptChatFlowActive()) {
      WindowManager.hideWindow('history', { persist:true, stopTimer:true });
      if (we?.edgeWrap) { we.edgeWrap.style.opacity='0'; we.edgeWrap.style.pointerEvents='none'; we.edgeWrap.style.display='none'; }
    }
  }

  function canOpenHistoryWindow() { return !isAnswerFlowActive() && !isGptChatFlowActive(); }
  function canOpenChatWindow()    { return !isAnswerFlowActive(); }

  /* ═══ SHOW / HIDE ══════════════════════════════════════════════════ */
  function showLoading() {
    const { widget, loader, fl } = ensureWidget();
    WindowManager.hideWindow('answer',  { persist:false, stopTimer:true });
    WindowManager.hideWindow('history', { persist:true,  stopTimer:true });
    WindowManager.hideWindow('chat',    { persist:true,  stopTimer:true });
    if (we?.edgeWrap) { we.edgeWrap.style.opacity='0'; we.edgeWrap.style.pointerEvents='none'; we.edgeWrap.style.display='none'; }
    // Apply Chameleon before showing loader so loader matches the page context
    if (shadowHost?.shadowRoot) {
      const rect = shadowHost.getBoundingClientRect?.() || { left: window.innerWidth - 80, top: 80 };
      qmApplyChameleonTo(shadowHost.shadowRoot, 'widget', rect.left || window.innerWidth - 80, rect.top || 80);
    }
    applyFloatingLoaderSide(fl);
    if (isMultiLoaderActive()) me?.placeLoader?.();
    fl.style.display     = 'inline-flex';
    loader.style.display = 'flex';
  }

  function placeDefaultAnswerWindowInActiveZone() {
    if (!we?.widget) return;
    const { widget } = we;
    const width  = widget.offsetWidth;
    const height = widget.offsetHeight;
    const zone   = resolveActiveZone();
    const x = zone === 'left'
      ? ANSWER_VIEWPORT_MARGIN
      : Math.max(ANSWER_VIEWPORT_MARGIN, window.innerWidth - width - ANSWER_VIEWPORT_MARGIN);
    const y = Math.max(ANSWER_VIEWPORT_MARGIN, window.innerHeight - height - ANSWER_VIEWPORT_MARGIN);
    widget.style.left   = `${x}px`;
    widget.style.top    = `${y}px`;
    widget.style.right  = 'auto';
    widget.style.bottom = 'auto';
  }

  function isUltraCompactAnswerText(answer) {
    const text = String(answer || '').trim();
    if (!text || text.length > 10 || text.includes('\n')) return false;
    if (/^(?:error|ошибка|не найден)/i.test(text)) return false;
    if (/[`*_#\[\]{}\\<>|]/.test(text)) return false;
    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(text)) return false;
    return !text.split(/\s+/).some(part => part.length > 10);
  }

  function measureAnswerControlsWidth() {
    if (!we?.hdr) return ANSWER_ULTRA_COMPACT_MIN_WIDTH;
    const hdrStyle = getComputedStyle(we.hdr);
    const controls = [...we.hdr.children].filter(el => getComputedStyle(el).display !== 'none');
    const gap = Number.parseFloat(hdrStyle.columnGap || hdrStyle.gap) || 0;
    const padding = (Number.parseFloat(hdrStyle.paddingLeft) || 0) + (Number.parseFloat(hdrStyle.paddingRight) || 0);
    const controlsWidth = controls.reduce((total, el) => total + el.offsetWidth, 0);
    return Math.ceil(padding + controlsWidth + Math.max(0, controls.length - 1) * gap);
  }

  function fitAnswerWindowToContent() {
    if (!we?.widget || !we?.body || !isAnswerDefaultLayoutMode()) return;
    const { widget, body } = we;
    requestAnimationFrame(() => {
      if (!widget.isConnected || widget.style.display === 'none' || !isAnswerDefaultLayoutMode()) return;

      const availableW = Math.max(40, window.innerWidth - ANSWER_VIEWPORT_MARGIN * 2);
      const availableH = Math.max(40, window.innerHeight - ANSWER_VIEWPORT_MARGIN * 2);
      const maxW = Math.min(ANSWER_COMPACT_MAX_WIDTH, availableW);
      const ultraCompact = widget.classList.contains('answer-window--ultra-compact');
      const contentMinW = ultraCompact
        ? Math.max(ANSWER_ULTRA_COMPACT_MIN_WIDTH, measureAnswerControlsWidth())
        : ANSWER_COMPACT_MIN_WIDTH;
      const minW = Math.min(contentMinW, maxW);
      const maxH = Math.min(getWindowConfig('answer').maxH || availableH, availableH);

      body.style.height = '';
      body.style.maxHeight = 'none';
      body.style.overflowY = 'visible';
      widget.style.minWidth = '0';
      widget.style.width = 'max-content';
      widget.style.height = 'auto';
      widget.style.maxWidth = `${maxW}px`;
      widget.style.maxHeight = `${maxH}px`;

      const measuredW = clamp(Math.ceil(widget.offsetWidth || widget.scrollWidth), minW, maxW);
      widget.style.width = `${measuredW}px`;

      const headerH = we?.hdr?.offsetHeight || 36;
      const timerH  = we?.tbar?.parentElement?.offsetHeight || 3;
      const maxBodyH = Math.max(0, maxH - headerH - timerH);
      const contentH = body.scrollHeight;
      body.style.maxHeight = `${maxBodyH}px`;
      body.style.overflowY = contentH > maxBodyH ? 'auto' : 'visible';

      placeDefaultAnswerWindowInActiveZone();
      widget.style.visibility = '';
    });
  }

  function updateAnswerLayout() {
    if (!we?.widget || !we?.body) return;
    const { widget, body } = we;
    if (!widget.isConnected) return;
    if (!isAnswerDefaultLayoutMode()) {
      requestAnimationFrame(() => {
        if (!widget.isConnected || widget.style.display === 'none') return;
        const headerH = we?.hdr?.offsetHeight || 36, timerH = we?.tbar?.parentElement?.offsetHeight || 3;
        const totalH  = widget.offsetHeight || 120;
        const bodyH   = Math.max(36, totalH - headerH - timerH);
        body.style.height = `${bodyH}px`; body.style.maxHeight = `${bodyH}px`; body.style.overflowY = 'auto';
      });
    } else {
      fitAnswerWindowToContent();
    }
  }

  /* ═══ FIX A+C: showAnswer — restores saved size, doesn't reset if user already resized ═══ */
  function showAnswer(text, model = '') {
    const { widget, body, loader, fl, updateNav } = ensureWidget();
    fl.style.display     = 'none';
    loader.style.display = 'none';

    const defaultLayout = isAnswerDefaultLayoutMode();
    if (defaultLayout) {
      widget.style.width    = 'auto'; widget.style.height = 'auto';
      widget.style.maxWidth = '';     widget.style.maxHeight = '';
      widget.style.visibility = 'hidden';
    }
    /* Always clear body sizing — will be recalculated by updateAnswerLayout */
    const b = we?.body;
    if (b) { b.style.height = ''; b.style.maxHeight = ''; b.style.overflowY = ''; }

    const baseRect = getWindowRect('answer');
    applyAnswerFrame(widget, { x: baseRect.x, y: baseRect.y }, {});

    histIdx = -1;
    const normalizedText = normalizeAnswerText(text);
    const isUltraCompactPlain = isUltraCompactAnswerText(normalizedText);
    widget.classList.toggle('answer-window--ultra-compact', isUltraCompactPlain);
    widget.classList.toggle('answer-window--normal', !isUltraCompactPlain);
    body.innerHTML = renderMarkdown(normalizedText);
    body.prepend(loader);
    if (!defaultLayout) updateAnswerLayout();

    if (model && we.modelSel) {
      currentModel = model;
      if (![...we.modelSel.options].find(o => o.value === model)) {
        const o = document.createElement('option'); o.value = model; o.textContent = shortName(model);
        we.modelSel.appendChild(o);
      }
      we.modelSel.value = model;
    }
    if (normalizedText && !normalizedText.startsWith('Ошибка:') && !normalizedText.startsWith('Error:') && !normalizedText.startsWith(ct('widget.error_prefix')) && !normalizedText.startsWith('Не найден')) {
      pushAnswerHistory({ answer: normalizedText, model: model || currentModel, query: lastQuestionText || getQuestionText(), ts: Date.now() });
      if (we?.historyPanel?.panel?.style?.display !== 'none') we.renderHistoryPanel?.();
    }
    updateNav();

    /* Chameleon: sample page colors at widget position before showing */
    if (shadowHost?.shadowRoot) {
      const rect = shadowHost.getBoundingClientRect?.() || { left: window.innerWidth - 80, top: 80 };
      qmApplyChameleonTo(shadowHost.shadowRoot, 'widget', rect.left || window.innerWidth - 80, rect.top || 80);
    }
    WindowManager.showWindow('answer', { restore: false, display: 'flex', updateLayout: false, startTimer: true });
    if (defaultLayout) fitAnswerWindowToContent();
    if (isHovered) timerStop();
    hideLowerPriorityWindows('answer_window_visible');
    if (we?.edgeWrap) { we.edgeWrap.style.opacity='0'; we.edgeWrap.style.pointerEvents='none'; we.edgeWrap.style.display='none'; }
  }

  /* ═══ MULTI-CHECK PANEL ════════════════════════════════════════════ */

  /* getMultiPanelPosition — DEFAULT spawn position: bottom corner of the active zone.
   * MultiCheck is NOT attached to the Answer window.  This function returns the
   * zone-bottom anchor regardless of where the Answer window is; collision
   * resolution (resolveMultiCollision) handles the case where that corner is
   * already occupied by the Answer window.
   *
   * panelW / panelH are passed in from fitToContent() so the SAME dimensions are
   * used for both the y-placement formula and the collision bounding-box check.
   * This eliminates the mismatch that previously caused the panel to overflow the
   * viewport bottom and produced incorrect collision rectangles. */
  function getMultiPanelPosition(panel, panelW, panelH) {
    panelW = panelW ?? Math.min(panel.offsetWidth  || 200, 320, window.innerWidth  - 8);
    panelH = panelH ?? Math.min(panel.offsetHeight || 60,        window.innerHeight - 8);
    const zone   = resolveActiveZone();
    const margin = 8;
    const x = zone === 'left' ? margin : Math.max(margin, window.innerWidth  - panelW - margin);
    const y = Math.max(0, window.innerHeight - panelH);   // flush with viewport bottom
    return { x, y, width: panelW, height: panelH };
  }

  function resolveMultiCollision(pos, panelW, panelH) {
    const answerEl = we?.widget;
    // Skip if Answer is absent, fully hidden, or mid-exit-animation (display:none set after 220ms,
    // but during the animation the element is still display:flex — use the class as the live signal).
    if (!answerEl || answerEl.style.display === 'none' || answerEl.classList.contains('qm-panel--hiding')) return pos;
    const ar = answerEl.getBoundingClientRect();
    if (!ar.width || !ar.height) return pos;
    const margin = 8;
    if (!(pos.x < ar.right && pos.x + panelW > ar.left && pos.y < ar.bottom && pos.y + panelH > ar.top)) return pos;
    /* Priority: 1↑ above, 2↓ below, 3→ right, 4← left */
    const aboveY = ar.top    - panelH - margin; if (aboveY >= margin)                                    return { x: pos.x, y: aboveY };
    const belowY = ar.bottom + margin;           if (belowY + panelH <= window.innerHeight - margin)     return { x: pos.x, y: belowY };
    const rx     = ar.right  + margin;           if (rx     + panelW <= window.innerWidth  - margin)     return { x: rx,    y: pos.y  };
    const lx     = ar.left   - panelW - margin;  if (lx     >= margin)                                   return { x: lx,    y: pos.y  };
    return pos;
  }

  function ensureMultiPanel() {
    if (me) return me;
    multiHost = document.createElement('div');
    multiHost.className = 'quizmind-multi-shadow-host';
    multiHost.setAttribute('data-quizmind-ui', 'multi');
    document.documentElement.appendChild(multiHost);
    const sr = multiHost.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
    :host,*{box-sizing:border-box;margin:0;padding:0;}
    @keyframes qm-in{from{opacity:0;transform:translateY(6px) scale(0.97);}to{opacity:1;transform:translateY(0) scale(1);}}
    @keyframes qm-pop{0%{transform:scale(0.88);opacity:0;}60%{transform:scale(1.04);opacity:1;}100%{transform:scale(1);}}
    @keyframes spin{to{transform:rotate(360deg);}}
    @keyframes qm-slide{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}
    @keyframes qm-panel-in{from{opacity:0;transform:scale(0.94) translateY(14px);}to{opacity:1;transform:scale(1) translateY(0);}}
    @keyframes qm-panel-out{from{opacity:1;transform:scale(1) translateY(0);}to{opacity:0;transform:scale(0.96) translateY(8px);}}
    .qm-panel--appearing{animation:qm-panel-in 0.26s cubic-bezier(0.22,1,0.36,1) both !important;}
    .qm-panel--hiding{animation:qm-panel-out 0.20s cubic-bezier(0.4,0,0.8,0.4) both !important;pointer-events:none !important;}
    @media(prefers-reduced-motion:reduce){.qm-panel--appearing,.qm-panel--hiding{animation:none !important;}.qm-panel--hiding{opacity:0 !important;}}
    .panel{
      position:fixed;left:20px;top:20px;
      width:auto;height:auto;min-height:0;min-width:0;
      background:var(--qm-surface,linear-gradient(165deg,rgba(255,255,255,0.72),rgba(241,245,252,0.58)));
      color:var(--qm-text,#0f172a);border-radius:var(--qm-radius,14px);
      box-shadow:var(--qm-shadow,0 16px 44px rgba(15,23,42,0.2)),0 1px 0 rgba(255,255,255,0.72) inset;
      border:1px solid var(--qm-border,rgba(255,255,255,0.70));
      backdrop-filter:blur(var(--qm-blur,18px)) saturate(1.18);
      -webkit-backdrop-filter:blur(var(--qm-blur,18px)) saturate(1.18);
      font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;user-select:none;
      z-index:2147483646;display:none;overflow:visible;flex-direction:column;
      transition:box-shadow 0.22s ease,border-color 0.22s ease;
    }
    .panel:hover{box-shadow:0 20px 52px rgba(15,23,42,0.24),0 1px 0 rgba(255,255,255,0.78) inset;border-color:rgba(191,219,254,0.80);}
    .phdr{display:flex;align-items:center;gap:4px;padding:6px 9px;background:var(--qm-header-bg,linear-gradient(180deg,rgba(255,255,255,0.72) 0%,rgba(248,251,255,0.54) 100%));border-bottom:1px solid var(--qm-border,rgba(226,232,240,0.6));cursor:grab;}
    .phdr:active{cursor:grabbing;}
    .ptitle{font-size:10px;font-weight:700;color:var(--qm-text,#0f172a);white-space:nowrap;display:inline-flex;align-items:center;gap:5px;letter-spacing:-0.01em;}
    .hdr-close{border:1px solid var(--qm-border,rgba(203,213,225,0.6));background:var(--qm-surface-2,rgba(255,255,255,0.68));cursor:pointer;width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:var(--qm-muted,#94a3b8);border-radius:6px;flex-shrink:0;padding:0;transition:background .18s ease,border-color .18s ease,transform .18s cubic-bezier(0.34,1.26,0.64,1);}
    .qm-window-icon{object-fit:contain;display:block;pointer-events:none;filter:var(--qm-icon-filter,none);}
    .qm-window-icon--inline{filter:var(--qm-icon-filter,none);}
    .qm-window-icon--inline svg{width:100%;height:100%;display:block;}
    .qm-window-icon--control{width:16px;height:16px;min-width:16px;min-height:16px;}
    .hdr-close:hover{background:var(--qm-accent-light,rgba(239,246,255,0.92));border-color:rgba(147,197,253,0.75);color:var(--qm-accent,#2563eb);transform:translateY(-1px) scale(1.06);}
    .hdr-close:active{transform:translateY(0) scale(0.95);}
    .qtoggle{margin-left:auto;}
    .qtxt{display:none;border:1px solid var(--qm-border,rgba(226,232,240,0.65));background:var(--qm-surface-2,rgba(255,255,255,0.7));border-radius:6px;padding:5px 7px;font-size:10px;line-height:1.45;color:var(--qm-text-2,#475569);white-space:pre-wrap;max-height:60px;overflow-y:auto;backdrop-filter:blur(8px);}
    .pbody{padding:6px 8px;overflow:visible;display:flex;flex-direction:column;gap:5px;min-height:0;flex:1 1 auto;user-select:text;}
    .result{border:1.5px solid var(--qm-border,rgba(226,232,240,0.7));border-radius:9px;padding:7px 9px;font-size:12px;line-height:1.45;max-width:100%;overflow-wrap:anywhere;word-break:break-word;animation:qm-slide 0.2s ease both;transition:border-color .18s ease,box-shadow .18s ease;}
    .result.ok{background:rgba(240,253,244,0.85);border-color:rgba(134,239,172,0.8);color:#166534;backdrop-filter:blur(8px);}
    .result.bad{background:rgba(254,242,242,0.85);border-color:rgba(252,165,165,0.8);color:#991b1b;backdrop-filter:blur(8px);}
    .result.warn{background:rgba(255,251,235,0.85);border-color:rgba(251,191,36,0.8);color:#92400e;backdrop-filter:blur(8px);}
    .result:hover{box-shadow:0 3px 10px rgba(15,23,42,0.08);}
    .sp{width:11px;height:11px;border:2px solid rgba(226,232,240,0.65);border-top-color:var(--qm-accent,#2563eb);border-radius:50%;animation:spin .7s cubic-bezier(0.4,0,0.2,1) infinite;display:inline-block;}
    .tbar-wrap{height:2px;flex:0 0 2px;width:100%;margin-top:auto;background:var(--qm-border,rgba(226,232,240,0.55));}
    .tbar{height:100%;width:100%;background:linear-gradient(90deg,rgba(147,197,253,0.8),#2563eb,rgba(124,58,237,0.85));transform-origin:left;transform:scaleX(1);}
    .mloader{position:fixed;width:46px;height:46px;border-radius:999px;border:1px solid var(--qm-border,rgba(255,255,255,0.72));background:var(--qm-surface,rgba(255,255,255,0.72));box-shadow:var(--qm-shadow,0 10px 28px rgba(15,23,42,0.2)),0 1px 0 rgba(255,255,255,0.70) inset;backdrop-filter:blur(18px) saturate(1.18);-webkit-backdrop-filter:blur(18px) saturate(1.18);z-index:2147483647;display:none;align-items:center;justify-content:center;animation:qm-pop 0.25s cubic-bezier(0.34,1.26,0.64,1) both;}
    `;

    const panel   = document.createElement('div'); panel.className = 'panel'; panel.style.display = 'none';
    const phdr    = document.createElement('div'); phdr.className = 'phdr';
    const ptitle  = document.createElement('div'); ptitle.className = 'ptitle';
    ptitle.append(document.createTextNode('Multi-Check'));
    const qtoggle = document.createElement('button'); qtoggle.className = 'hdr-close qtoggle'; qtoggle.type = 'button'; qtoggle.title = ct('widget.history'); setWindowButtonIcon(qtoggle, { fileName: WINDOW_ICONS.history, alt: ct('widget.history') });
    const ppin    = document.createElement('button'); ppin.className = 'hdr-close'; ppin.type = 'button'; ppin.title = ct('widget.pin_window'); setWindowButtonIcon(ppin, { fileName: WINDOW_ICONS.keep, alt: ct('widget.pin_window') });
    const pclose  = document.createElement('button'); pclose.className = 'hdr-close'; pclose.type = 'button'; setWindowButtonIcon(pclose, { fileName: WINDOW_ICONS.close, alt: ct('widget.close_window') });
    phdr.append(ptitle, qtoggle, ppin, pclose);

    const pbody   = document.createElement('div'); pbody.className = 'pbody';
    const qtxt    = document.createElement('div'); qtxt.className = 'qtxt';
    const tbarWrap = document.createElement('div'); tbarWrap.className = 'tbar-wrap';
    const tbar     = document.createElement('div'); tbar.className = 'tbar';
    tbarWrap.appendChild(tbar);
    const mloader  = document.createElement('div'); mloader.className = 'mloader';
    mloader.innerHTML = '<span class="sp" style="width:14px;height:14px;border-width:2.5px"></span>';
    panel.append(phdr, pbody, tbarWrap);
    sr.append(style, panel, mloader);
    qmApplyThemeTo(sr, 'inpage');

    /* placeLoader — positions the multi floating loader via LoaderController.
     * _multiLoaderAnchor always reflects the latest resolved panel position so
     * the loader stays in sync even when windowLayoutState.multi is stale. */
    let _multiLoaderAnchor = null;
    const multiLoaderCtrl = new window.__QM.LoaderController({
      loaderEl:      mloader,
      getWindowRect: () => _multiLoaderAnchor || windowLayoutState.multi,
      getZone:       () => resolveActiveZone(),
      loaderSize:    46,
      fallback:      'near-answer',
      getAnswerEl:   () => we?.widget,
      getAnswerRect: () => windowLayoutState.answer,
    });
    /* placeLoader — always computes the anchor position from scratch using the
     * exact same 2-mode + collision logic as fitToContent() so the loader is
     * NEVER out of sync with where the panel is (or will be).
     *
     * Panel may be hidden (display:none) when this is called (loading phase).
     * In that case panel.offsetWidth/Height are 0; we use the saved width/height
     * from windowLayoutState.multi (set by persistWindowRect) or fallback values.
     * This ensures custom-position + collision-resolution work on the loader
     * even before the panel first appears and even after a page reload. */
    const placeLoader = () => {
      const saved = windowLayoutState.multi;
      const hasCustomCoords = saved &&
        Number.isFinite(Number(saved.x)) && Number(saved.x) > 2 &&
        Number.isFinite(Number(saved.y)) && Number(saved.y) > 2;
      let basePos, estW, estH;
      if (hasCustomCoords) {
        // Use the dimensions that were saved alongside the position (by persistWindowRect)
        estW = Number(saved.width)  || panel.offsetWidth  || 200;
        estH = Number(saved.height) || panel.offsetHeight || 60;
        basePos = {
          x: clamp(Number(saved.x), 0, Math.max(0, window.innerWidth  - estW)),
          y: clamp(Number(saved.y), 0, Math.max(0, window.innerHeight - estH)),
        };
      } else {
        // DEFAULT: zone-bottom corner (mirrors getMultiPanelPosition)
        estW = panel.offsetWidth  || 200;
        estH = panel.offsetHeight || 60;
        const zone = resolveActiveZone();
        const margin = 8;
        basePos = {
          x: zone === 'left' ? margin : Math.max(margin, window.innerWidth - estW - margin),
          y: Math.max(0, window.innerHeight - estH),
        };
      }
      const pos = resolveMultiCollision(basePos, estW, estH);
      // resolveMultiCollision only checks the Answer *window*, which is hidden during
      // parallel loading (display:none). When both loaders are active simultaneously,
      // directly test loader-vs-loader overlap and shift the multi loader anchor up.
      const lSize = 46;
      const ansFlEl = we?.fl;
      if (ansFlEl && ansFlEl.style.display !== 'none') {
        const zone  = resolveActiveZone();
        const mlX   = zone === 'left' ? pos.x : pos.x + estW - lSize;
        const mlY   = pos.y + estH - lSize;
        const alsl  = parseFloat(ansFlEl.style.left);
        const alst  = parseFloat(ansFlEl.style.top);
        const alX   = (Number.isFinite(alsl) && Number.isFinite(alst)) ? alsl : (zone === 'left' ? 0 : window.innerWidth  - lSize);
        const alY   = (Number.isFinite(alsl) && Number.isFinite(alst)) ? alst : window.innerHeight - lSize;
        if (mlX < alX + lSize && mlX + lSize > alX && mlY < alY + lSize && mlY + lSize > alY) {
          // Back-compute anchor.y so that the loader lands just above the answer loader
          pos.y = Math.max(0, alY - estH - 8);
        }
      }
      _multiLoaderAnchor = { x: pos.x, y: pos.y, width: estW, height: estH };
      multiLoaderCtrl.place();
    };

    /* Multi-check timer — unified TimerController replaces the previous 3-variable
     * inline implementation (timerId, multiTimerEnd, multiTimerPaused, multiTimerRemaining,
     * startTimer, stopTimer, and two duplicate tick() closures). */
    let pinned           = false;
    // Initialise from stored flag so custom size survives page reload.
    // windowLayoutState.multiResized is loaded by loadWindowLayoutState() before ensureMultiPanel() runs.
    let multiUserResized = Boolean(windowLayoutState.multiResized);
    let multiUserMoved   = false;  // true once user manually drags the panel (CUSTOM mode)

    const multiTimer = new window.__QM.TimerController({
      onTick:     ratio => { tbar.style.transform = `scaleX(${ratio})`; },
      onExpire:   () => WindowManager.hideWindow('multi', { persist: true, stopTimer: true }),
      getPinned:  () => pinned,
      getVisible: () => panel.style.display !== 'none' && !panel.classList.contains('qm-panel--hiding'),
    });

    const stopTimer  = () => multiTimer.stop();
    const startTimer = () => { tbar.style.transform = 'scaleX(1)'; multiTimer.start(WIDGET_TIMER_MS); };

    panel.addEventListener('mouseenter', () => { if (!pinned) { multiTimer.stop(); tbar.style.transform = 'scaleX(1)'; } });
    panel.addEventListener('mouseleave', () => { if (!pinned) startTimer(); });

    const fitToContent = () => {
      requestAnimationFrame(() => {
        if (panel.style.display === 'none') return;
        const tbarH = tbarWrap.style.display === 'none' ? 0 : 2;
        const hdrH  = phdr.offsetHeight || 28;

        if (!multiUserResized) {
          const maxW = Math.min(320, window.innerWidth - 8);
          const maxH = window.innerHeight - 8;
          panel.style.width = 'auto'; panel.style.height = 'auto';
          pbody.style.maxHeight = 'none'; pbody.style.overflowY = 'visible';
          const naturalW = clamp(Math.ceil(panel.scrollWidth),                   0, maxW);
          const naturalH = clamp(Math.ceil(hdrH + pbody.scrollHeight + tbarH), 0, maxH);
          panel.style.width = `${naturalW}px`; panel.style.height = `${naturalH}px`;
        }
        /* Always sync pbody constraints to actual panel height so tbarWrap stays at bottom
           edge even when user has manually resized the panel taller than the content. */
        const currentPanelH = panel.offsetHeight || 60;
        const bodyMax = Math.max(0, currentPanelH - hdrH - tbarH);
        pbody.style.maxHeight = `${bodyMax}px`;
        pbody.style.overflowY = pbody.scrollHeight > bodyMax ? 'auto' : 'visible';

        const panelW = panel.offsetWidth  || 200;
        const panelH = panel.offsetHeight || 60;

        /* ── 2-mode positioning ──────────────────────────────────────────
         * CUSTOM  : windowLayoutState.multi has valid persisted coords (written
         *           only by user drag/resize → persistWindowRect; survives reload;
         *           cleared only on explicit close/qtoggle reset).
         *           → use saved coords, apply collision resolution.
         * DEFAULT : no saved coords → spawn at active-zone bottom corner.
         *           → collision resolution shifts it UP if Answer occupies that
         *             spot (then DOWN / RIGHT / LEFT as fallback).
         * _multiLoaderAnchor is updated with the resolved position so the loader
         * always matches the panel position exactly.
         * ──────────────────────────────────────────────────────────────── */
        const _saved = windowLayoutState.multi;
        const hasCustomCoords = _saved &&
          Number.isFinite(Number(_saved.x)) && Number(_saved.x) > 2 &&
          Number.isFinite(Number(_saved.y)) && Number(_saved.y) > 2;

        const basePos = hasCustomCoords
          ? { x: clamp(Number(_saved.x), 0, Math.max(0, window.innerWidth  - panelW)),
              y: clamp(Number(_saved.y), 0, Math.max(0, window.innerHeight - panelH)) }
          : getMultiPanelPosition(panel, panelW, panelH);

        const pos = resolveMultiCollision(basePos, panelW, panelH);
        panel.style.left = `${pos.x}px`;
        panel.style.top  = `${pos.y}px`;
        // Keep loader anchor in sync so placeLoader() always uses the resolved coords
        _multiLoaderAnchor = { x: pos.x, y: pos.y, width: panelW, height: panelH };
        // Reveal the panel now that it sits at its final position — no visible jump.
        panel.style.visibility = '';
      });
    };

    const applyPin = () => {
      setWindowButtonIcon(ppin, { fileName: pinned ? WINDOW_ICONS.keepOff : WINDOW_ICONS.keep, alt: pinned ? ct('widget.unpin_window') : ct('widget.pin_window') });
      ppin.title = pinned ? ct('widget.unpin_window') : ct('widget.pin_window');
      tbarWrap.style.display = pinned ? 'none' : 'block';
      // Do NOT call fitToContent() here — that resets any user-set size.
      // Only recalculate content-fit size if user has NOT manually resized.
      if (!multiUserResized) fitToContent();
    };

    ppin.addEventListener('click', () => {
      pinned = !pinned;
      if (pinned) {
        const r = captureRect(panel, 'multi');
        if (r) { windowLayoutState.multi = r; saveWindowLayoutState(); }
        stopTimer();
      } else {
        startTimer();
      }
      applyPin();
    });

    pclose.addEventListener('click', () => {
      multiUserMoved = false; multiUserResized = false;
      // Clear both position and resize flag so next show starts in true DEFAULT mode.
      windowLayoutState.multi = null; windowLayoutState.multiResized = false;
      saveWindowLayoutState();
      // persist:false — we already cleared windowLayoutState.multi above; using persist:true
      // would call persistWindowRect() which re-saves the panel's current position, undoing the reset.
      WindowManager.hideWindow('multi', { persist: false, stopTimer: true });
    });

    qtoggle.addEventListener('click', () => {
      const show = qtxt.style.display !== 'block';
      qtxt.style.display = show ? 'block' : 'none';
      qtoggle.title = ct('widget.history');
      if (show) pbody.prepend(qtxt); else qtxt.remove();
      multiUserMoved = false; multiUserResized = false;
      windowLayoutState.multi = null; windowLayoutState.multiResized = false;
      saveWindowLayoutState();  // reset to DEFAULT mode; next show re-derives zone-bottom position
      fitToContent();
    });

    /* drag + resize — DragResizeController replaces ~80 lines of inline code */
    const multiDragResize = new window.__QM.DragResizeController({
      el:                 panel,
      winKey:             'multi',
      cfg:                getWindowConfig('multi'),
      dragHandle:         phdr,
      forbiddenNodes:     [ppin, pclose, qtoggle],
      onDragEnd:          () => { multiUserMoved = true; persistWindowRect('multi', panel); fitToContent(); },
      onResizeEnd:        () => {
        multiUserResized = true;
        // Persist the resize flag durably so fitToContent() skips auto-size after reload.
        windowLayoutState.multiResized = true;
        persistWindowRect('multi', panel);
        saveWindowLayoutState();
      },
      addManagedListener,
    });
    multiDragResize.bind();

    applyPin();
    me = { panel, pbody, qtxt, mloader, fitToContent, placeLoader, reposition: fitToContent, startTimer, stopTimer, isPinned: () => pinned,
           resetUserFlags: () => { multiUserMoved = false; multiUserResized = false; } };
    WindowManager.createWindow('multi', {
      panel,
      getPinned:   () => pinned,
      startTimer:  () => startTimer(),
      stopTimer:   () => stopTimer(),
      // Only persist when the user explicitly moved or resized the panel.
      // DEFAULT-mode positions (zone-bottom or collision-resolved) must NOT be saved as
      // "custom" coords — that would make hasCustomCoords=true on the next show and
      // cause the panel to re-use a stale/wrong position.
      persistRect: () => { if (multiUserMoved || multiUserResized) persistWindowRect('multi', panel); },
      restoreRect: () => {
        // fitToContent() is NOT called here — panel is still display:none at this point.
        // showMultiResultPanel calls fitToContent() after setting display:flex.
      },
    });
    return me;
  }

  /* ═══ MULTI-CHECK FLOW ═════════════════════════════════════════════ */
  async function runMultiCheck({ questionText, primaryAnswer = '', primaryAnswerDeferred = null, force = false, requestKind = 'text' } = {}) {
    if (requestKind !== 'text') return;
    if (!force && !multiCheckEnabled) return;
    const q = String(questionText || getQuestionText() || '').trim();
    if (!q || !runtimeOk()) return;
    let models = cachedModels;
    if (!models.length) { try { const s = await window.TASettingsStorage?.getSettings(); models = s?.multi_check_models || []; } catch {} }
    models = [...new Set((Array.isArray(models) ? models : []).map(m => String(m||'').trim()).filter(Boolean))];
    if (!models.length) return;
    const { panel, pbody, qtxt, mloader, fitToContent, placeLoader, startTimer } = ensureMultiPanel();
    /* FIX (C1): normalise comma spacing so "a,c" === "a, c" === "a , c" */
    const normalizeAns = v => String(v||'').trim().replace(/\s*,\s*/g, ', ').replace(/\s+/g,' ').toLowerCase();
    try {
      placeLoader?.();
      if (mloader) mloader.style.display = 'inline-flex';
      // Fire GET_MULTI_CONSENSUS immediately — Round-1/Debate/Judge do not depend on the
      // primary answer. primaryAnswer:'' is intentional; verdict is recomputed below once
      // the actual primary answer is available (via primaryAnswerDeferred or the argument).
      const multiPromise = safeSendMessage({ type:'GET_MULTI_CONSENSUS', payload:{ questionText:q, models, primaryAnswer:'' } });
      // Await both the multi pipeline and the resolved primary answer concurrently.
      // For parallel calls from runAnswerFlow, primaryAnswerDeferred settles when GET_ANSWER
      // returns. For force-mode / direct calls, primaryAnswerDeferred is null and we wrap
      // the supplied primaryAnswer string in an already-resolved Promise.
      const [r, resolvedPrimary] = await Promise.all([
        multiPromise,
        primaryAnswerDeferred ?? Promise.resolve(primaryAnswer),
      ]);
      if (!r?.ok) throw new Error(r?.error || 'Failed to get Multi-Check result');
      const consensus = String(r.consensus||'').trim();
      if (!consensus) throw new Error(ct('widget.multi_check_no_result'));
      const original = String(resolvedPrimary||'').trim() || String(ansHistory[ansHistory.length-1]?.answer||'').trim();

      /* Delegate verdict computation to the background so computeTextVerdict() in
       * multiCheck.js remains the single source of truth for threshold values and
       * matching rules. This call is a fast synchronous operation on the service-worker
       * side; only the Chrome IPC round-trip (~1–3 ms) is added after both sides settle. */
      const vr       = await safeSendMessage({ type:'GET_TEXT_VERDICT', payload:{
        originalAnswer:  original,
        consensus,
        judgeConfidence: r.confidence,
        judgeVerdict:    r.judgeVerdict,
      }});
      const verdict   = vr?.verdict ?? 'uncertain';
      const accepted  = verdict === 'correct';
      const uncertain = verdict === 'uncertain';

      showMultiResultPanel({ question:q, original, consensus, accepted, uncertain });
    } catch {
      pbody.innerHTML = '';
      const finalBox = document.createElement('div'); finalBox.className = 'result bad';
      finalBox.innerHTML = `<span style="font-size:11px;font-weight:700;">✘</span> <span style="font-size:11px;">${ct('widget.multi_check_failed')}</span>`;
      pbody.appendChild(finalBox);
      WindowManager.showWindow('multi', { restore:true, display:'flex', startTimer:false });
      fitToContent?.(); startTimer();
    } finally {
      if (mloader) mloader.style.display = 'none';
    }
  }

  function showMultiResultPanel({ question = '', original = '', consensus = '', accepted = false, uncertain = false } = {}) {
    const { panel, pbody, qtxt, fitToContent, startTimer } = ensureMultiPanel();
    qtxt.textContent = String(question||'').trim() || 'Screenshot';
    pbody.innerHTML  = '';
    const finalBox   = document.createElement('div');
    if (uncertain) {
      finalBox.className = 'result warn';
      finalBox.innerHTML = `<span style="font-size:11px;font-weight:700;margin-right:6px;">⚠ ${ct('widget.uncertain')}</span><span style="font-size:12px;font-weight:600;">${(consensus||'—').replace(/</g,'&lt;')}</span>`;
    } else if (accepted) {
      finalBox.className = 'result ok';
      finalBox.innerHTML = `<span style="font-size:11px;font-weight:700;margin-right:6px;">✔ ${ct('widget.correct')}</span><span style="font-size:13px;font-weight:700;">${(original||consensus||'—').replace(/</g,'&lt;')}</span>`;
    } else {
      finalBox.className = 'result bad';
      finalBox.innerHTML = `<span style="font-size:11px;font-weight:700;margin-right:6px;">✘ ${ct('widget.incorrect')}</span><span style="font-size:12px;font-weight:600;">${(original||'—').replace(/</g,'&lt;')} → ${(consensus||'—').replace(/</g,'&lt;')}</span>`;
    }
    pbody.appendChild(finalBox);
    // Suppress the first-frame paint at the wrong default position (left:20px/top:20px).
    // fitToContent clears this flag inside its requestAnimationFrame callback once the
    // collision-resolved coordinates have been written — so the panel only becomes
    // visible after it is already at its final place.
    if (panel.style.display === 'none' || !panel.style.display) panel.style.visibility = 'hidden';
    WindowManager.showWindow('multi', { restore:true, display:'flex', startTimer:false });
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    fitToContent?.(); startTimer();
  }

  /* ═══ SETTINGS PANEL ════════════════════════════════════════════════ */
  function ensureSettings() {
    if (settingsEl) return settingsEl;
    settingsHost = document.createElement('div');
    settingsHost.className = 'quizmind-settings-shadow-host';
    settingsHost.setAttribute('data-quizmind-ui', 'settings');
    document.documentElement.appendChild(settingsHost);
    const sr = settingsHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
    :host,*{box-sizing:border-box;margin:0;padding:0;}
    @keyframes qm-in{from{opacity:0;transform:translateY(-6px) scale(0.97);}to{opacity:1;transform:translateY(0) scale(1);}}
    @keyframes qm-tog{0%{transform:scale(0.85);}60%{transform:scale(1.1);}100%{transform:scale(1);}}
    .pop{
      position:fixed;top:16px;right:16px;width:min(290px,calc(100vw - 20px));
      background:var(--qm-surface,linear-gradient(165deg,rgba(255,255,255,0.72),rgba(241,245,252,0.58)));
      color:var(--qm-text,#0f172a);
      border:1px solid var(--qm-border,rgba(255,255,255,0.72));
      border-radius:var(--qm-radius,16px);
      box-shadow:var(--qm-shadow,0 16px 44px rgba(15,23,42,0.20)),0 1px 0 rgba(255,255,255,0.72) inset;
      backdrop-filter:blur(var(--qm-blur,18px)) saturate(1.18);
      -webkit-backdrop-filter:blur(var(--qm-blur,18px)) saturate(1.18);
      z-index:2147483644;
      font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;
      display:none;overflow:hidden;
      animation:qm-in 0.26s cubic-bezier(0.34,1.12,0.64,1) both;
    }
    .phdr{display:flex;align-items:center;justify-content:space-between;padding:11px 13px;border-bottom:1px solid var(--qm-border,rgba(226,232,240,0.6));background:var(--qm-header-bg,linear-gradient(180deg,rgba(255,255,255,0.72) 0%,rgba(248,251,255,0.52) 100%));}
    .ptitle{font-size:13px;font-weight:700;display:flex;align-items:center;gap:7px;letter-spacing:-0.01em;}
    .plink{font-size:11px;color:var(--qm-accent,#2563eb);background:none;border:none;cursor:pointer;font-family:inherit;text-decoration:none;font-weight:600;padding:3px 8px;border-radius:6px;transition:background .15s ease;}
    .plink:hover{background:var(--qm-accent-light,rgba(239,246,255,0.85));}
    .picon-btn{border:1px solid var(--qm-border,rgba(203,213,225,0.55));background:var(--qm-surface-2,rgba(255,255,255,0.68));cursor:pointer;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;padding:0;color:var(--qm-muted,#94a3b8);border-radius:7px;flex-shrink:0;transition:background .18s ease,border-color .18s ease,transform .18s cubic-bezier(0.34,1.26,0.64,1);}
    .picon-btn:hover{background:var(--qm-accent-light,rgba(239,246,255,0.92));border-color:rgba(147,197,253,0.75);color:var(--qm-accent,#2563eb);transform:translateY(-1px) scale(1.06);}
    .picon-btn:active{transform:translateY(0) scale(0.95);}
    .pbody{padding:4px 13px 10px;display:grid;gap:0;}
    .tr{display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--qm-border,rgba(241,245,249,0.75));font-size:12px;transition:background .12s ease;border-radius:6px;}
    .tr:last-of-type{border-bottom:none;}
    .tl{font-weight:600;color:var(--qm-text-2,#334155);display:flex;align-items:center;gap:6px;}.ts{font-size:10px;color:var(--qm-muted,#94a3b8);margin-top:2px;}
    .tl-icon{width:16px;height:16px;min-width:16px;min-height:16px;object-fit:contain;display:inline-block;flex-shrink:0;filter:var(--qm-icon-filter,none);}
    .tl-icon.qm-icon--inline{display:inline-flex;align-items:center;justify-content:center;filter:var(--qm-icon-filter,none);}
    .tl-icon.qm-icon--inline svg{width:100%;height:100%;display:block;}
    .ss-title{display:inline-flex;align-items:center;gap:6px;}
    .tog{position:relative;flex-shrink:0;width:38px;height:21px;border-radius:999px;border:1px solid rgba(203,213,225,0.5);cursor:pointer;background:var(--qm-toggle-off,#cbd5e1);transition:background .22s cubic-bezier(0.4,0,0.2,1),border-color .22s ease,box-shadow .22s ease;outline:none;}
    .tog::before{content:'';position:absolute;width:15px;height:15px;border-radius:50%;background:#ffffff;top:2px;left:2px;transition:transform .22s cubic-bezier(0.34,1.26,0.64,1);box-shadow:0 1px 4px rgba(0,0,0,0.22);}
    .tog[data-on=true]{background:var(--qm-success,#22c55e);border-color:rgba(22,163,74,0.4);box-shadow:0 0 0 2px rgba(22,163,74,0.14);}
    .tog[data-on=true]::before{transform:translateX(17px);}
    .zone-btn{border:1px solid var(--qm-border,rgba(203,213,225,0.65));border-radius:8px;background:var(--qm-surface-2,rgba(255,255,255,0.72));padding:4px 10px;font-size:11px;color:var(--qm-text-2,#334155);cursor:pointer;font-family:inherit;font-weight:600;transition:background .15s ease,border-color .15s ease,transform .15s cubic-bezier(0.34,1.26,0.64,1);}
    .zone-btn:hover{background:rgba(255,255,255,0.92);border-color:rgba(147,197,253,0.7);transform:translateY(-1px);}
    .zone-btn:active{transform:translateY(0);}
    .st{font-size:11px;color:var(--qm-success,#16a34a);min-height:14px;padding:4px 0 2px;font-weight:600;}
    .foot{padding:9px 13px;border-top:1px solid var(--qm-border,rgba(226,232,240,0.55));display:flex;gap:7px;background:rgba(248,251,255,0.40);}
    .dlbtn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--qm-border,rgba(203,213,225,0.65));border-radius:8px;background:var(--qm-surface-2,rgba(255,255,255,0.72));padding:5px 11px;font-size:11px;cursor:pointer;color:var(--qm-text-2,#334155);font-family:inherit;font-weight:600;transition:background .15s ease,border-color .15s ease,transform .15s cubic-bezier(0.34,1.26,0.64,1);}
    .dlbtn:hover{background:rgba(255,255,255,0.92);border-color:rgba(147,197,253,0.7);transform:translateY(-1px);}
    .dlbtn:active{transform:translateY(0);}
    .coll{border:1px solid var(--qm-border,rgba(226,232,240,0.65));border-radius:10px;padding:9px;margin-top:8px;background:var(--qm-surface-2,rgba(248,250,252,0.70));backdrop-filter:blur(8px);}
    .coll-head{display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-size:12px;font-weight:600;color:var(--qm-text-2,#334155);transition:color .15s ease;}
    .coll-head:hover{color:var(--qm-text,#0f172a);}
    .coll-body{display:none;margin-top:8px;gap:8px;}
    .fld{display:grid;gap:4px;}
    .fld input{height:32px;border:1px solid var(--qm-border,rgba(203,213,225,0.65));border-radius:8px;padding:0 9px;font-size:12px;font-family:inherit;background:var(--qm-input-bg,rgba(255,255,255,0.88));color:var(--qm-text,#0f172a);outline:none;transition:border-color .18s ease,box-shadow .18s ease;}
    .fld input:focus{border-color:var(--qm-accent,#2563eb);box-shadow:0 0 0 2px rgba(37,99,235,0.16);}
    `;
    const pop    = document.createElement('section'); pop.className = 'pop';
    const phdr   = document.createElement('div');     phdr.className = 'phdr';
    const ptitle = document.createElement('div');     ptitle.className = 'ptitle';
    const ptitleIcon = createIcon({ fileName: WIDGET_ICONS.settings, alt: ct('widget.settings'), className: 'tl-icon' });
    const ptitleText = document.createElement('span'); ptitleText.textContent = ct('widget.settings');
    ptitle.append(ptitleIcon, ptitleText);
    const pacts  = document.createElement('div');     pacts.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const ppin   = document.createElement('button');  ppin.className = 'picon-btn'; ppin.title = ct('widget.pin_window'); setWindowButtonIcon(ppin, { fileName: WINDOW_ICONS.keep, alt: ct('widget.pin_window') });
    let settingsPinned = false;
    ppin.addEventListener('click', () => { settingsPinned = !settingsPinned; setWindowButtonIcon(ppin, { fileName: settingsPinned ? WINDOW_ICONS.keepOff : WINDOW_ICONS.keep, alt: settingsPinned ? ct('widget.unpin_window') : ct('widget.pin_window') }); });
    const plink  = document.createElement('button');  plink.className = 'plink'; plink.textContent = ct('widget.all_settings');
    plink.addEventListener('click', () => { chrome.runtime?.openOptionsPage?.(); hideSettings(); });
    pacts.append(ppin, plink);
    phdr.append(ptitle, pacts);

    const pbody   = document.createElement('div'); pbody.className = 'pbody';
    const zoneRow = document.createElement('div'); zoneRow.className = 'tr';
    const zoneInfo = document.createElement('div');
    const zoneLbl  = document.createElement('div'); zoneLbl.className = 'tl';
    zoneLbl.append(createIcon({ fileName: WIDGET_ICONS.activityZone, alt: ct('widget.activity_zone'), className: 'tl-icon' }), document.createTextNode(ct('widget.activity_zone_short')));
    const zoneSub  = document.createElement('div'); zoneSub.className = 'ts'; zoneSub.textContent = ct('widget.zone_sub');
    zoneInfo.append(zoneLbl, zoneSub);
    const zoneBtn = document.createElement('button'); zoneBtn.className = 'zone-btn'; zoneBtn.type = 'button';
    zoneBtn.textContent = widgetSide === 'left' ? '⬅ Left' : '➡ Right';
    zoneBtn.addEventListener('click', async () => {
      const next = widgetSide === 'left' ? 'right' : 'left';
      zoneBtn.textContent = next === 'left' ? '⬅ Left' : '➡ Right';
      applyWidgetSide(next);
      await window.TASettingsStorage?.setSettings({ active_zone:next, widget_position:next }).catch(() => {});
    });
    zoneRow.append(zoneInfo, zoneBtn);
    pbody.appendChild(zoneRow);

    const TOGGLES = [
      { key:'multi_check_enabled',   label:'Multi Check',       icon:WIDGET_ICONS.multiCheck,      subKey:'widget.toggle_multi_check_sub' },
      { key:'auto_send_screenshot',  labelKey:'widget.toggle_auto_screenshot', icon:null,           subKey:'widget.toggle_auto_screenshot_sub' },
      { key:'save_logs',             labelKey:'widget.toggle_logs',            icon:WIDGET_ICONS.logs, subKey:'widget.toggle_logs_sub' },
      { key:'test_mode',             labelKey:'widget.toggle_test_mode',       icon:WIDGET_ICONS.testMode, subKey:'widget.toggle_test_mode_sub' },
      { key:'developer_mode',        label:'Developer mode',    icon:WIDGET_ICONS.developerMode,   subKey:'widget.toggle_developer_mode_sub' },
      { key:'quiz_page_scan_enabled', label:'Quiz page scan',   icon:WIDGET_ICONS.documentScanner, subKey:'widget.toggle_quiz_scan_sub' },
      { key:'quiz_auto_apply_enabled',label:'Quiz auto-apply',  icon:null,                         subKey:'widget.toggle_quiz_auto_apply_sub' },
    ];
    const togEls = {};
    let saveTimer=null, savedTimer=null;
    const statusEl = document.createElement('div'); statusEl.className = 'st';
    function debounce(partial) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try { await window.TASettingsStorage?.setSettings(partial); statusEl.textContent=ct('widget.saved_check'); clearTimeout(savedTimer); savedTimer=setTimeout(()=>{statusEl.textContent='';},1500); } catch {}
      }, 300);
    }
    for (const t of TOGGLES) {
      const row  = document.createElement('div'); row.className = 'tr';
      const info = document.createElement('div');
      const lbl  = document.createElement('div'); lbl.className = 'tl';
      const tLabel = t.labelKey ? ct(t.labelKey) : (t.label || '');
      if (t.icon) lbl.appendChild(createIcon({ fileName:t.icon, alt:tLabel, className:'tl-icon' }));
      lbl.appendChild(document.createTextNode(tLabel));
      const sub  = document.createElement('div'); sub.className = 'ts'; sub.textContent = t.subKey ? ct(t.subKey) : (t.sub || '');
      info.append(lbl, sub);
      const btn  = document.createElement('button'); btn.className = 'tog'; btn.type = 'button'; btn.dataset.on = 'false';
      btn.addEventListener('click', () => { const n = btn.dataset.on !== 'true'; btn.dataset.on = String(n); debounce({ [t.key]: n }); });
      togEls[t.key] = btn;
      row.append(info, btn); pbody.appendChild(row);
    }
    const ssColl = document.createElement('div'); ssColl.className = 'coll';
    const ssHead = document.createElement('div'); ssHead.className = 'coll-head';
    const ssTitle = document.createElement('span'); ssTitle.className = 'ss-title';
    ssTitle.append(createIcon({ fileName: WIDGET_ICONS.screenshotSettings, alt: 'Screenshot Model Settings', className: 'tl-icon' }), document.createTextNode('Screenshot Model Settings'));
    const ssCaret = document.createElement('span'); ssCaret.textContent = '▾';
    ssHead.append(ssTitle, ssCaret);
    const ssBody = document.createElement('div'); ssBody.className = 'coll-body'; ssBody.style.display = 'none';
    const tempField = document.createElement('label'); tempField.className = 'fld'; tempField.innerHTML = '<span>Temperature</span>';
    const tempInput = document.createElement('input'); tempInput.type='number'; tempInput.min='0'; tempInput.max='1'; tempInput.step='0.05'; tempInput.value=String(screenshotTemperature);
    tempInput.addEventListener('input', () => { const v=Math.max(0,Math.min(1,Number(tempInput.value)||0)); screenshotTemperature=v; debounce({screenshot_temperature:v}); });
    tempField.appendChild(tempInput);
    const tokField = document.createElement('label'); tokField.className = 'fld'; tokField.innerHTML = '<span>Max tokens</span>';
    const tokInput = document.createElement('input'); tokInput.type='number'; tokInput.min='32'; tokInput.max='2048'; tokInput.step='1'; tokInput.value=String(screenshotMaxTokens);
    tokInput.addEventListener('input', () => { const v=Math.max(32,Math.min(2048,Math.floor(Number(tokInput.value)||500))); screenshotMaxTokens=v; debounce({screenshot_max_tokens:v}); });
    tokField.appendChild(tokInput);
    ssBody.append(tempField, tokField);
    ssColl.append(ssHead, ssBody);
    ssHead.addEventListener('click', () => { const open=ssBody.style.display!=='grid'; ssBody.style.display=open?'grid':'none'; ssCaret.textContent=open?'▴':'▾'; });
    pbody.appendChild(ssColl); pbody.appendChild(statusEl);
    const foot  = document.createElement('div');    foot.className = 'foot';
    const dlBtn = document.createElement('button'); dlBtn.className = 'dlbtn';
    dlBtn.append(createIcon({ fileName: WIDGET_ICONS.logs, alt: ct('widget.logs'), className: 'tl-icon' }), document.createTextNode(ct('widget.download_logs')));
    dlBtn.addEventListener('click', async () => {
      try {
        const ok = await qmDownloadLog();
        statusEl.textContent = ok ? ct('widget.downloaded') : ct('widget.empty');
      } catch { statusEl.textContent = ct('widget.empty'); }
    });
    foot.appendChild(dlBtn);
    pop.append(phdr, pbody, foot);
    sr.append(style, pop);
    qmApplyThemeTo(sr, 'settings');
    settingsEl = { pop, togEls, statusEl, zoneBtn, screenshotTempInput:tempInput, screenshotTokensInput:tokInput };
    return settingsEl;
  }

  async function openSettings() {
    const s = ensureSettings();
    try {
      const cfg = await window.TASettingsStorage?.getSettings();
      if (cfg) for (const [k,b] of Object.entries(s.togEls)) b.dataset.on = String(Boolean(cfg[k]));
      if (s.zoneBtn) s.zoneBtn.textContent = (cfg?.active_zone||widgetSide)==='left'?'⬅ Left':'➡ Right';
      if (s.screenshotTempInput)  s.screenshotTempInput.value  = String(Number.isFinite(Number(cfg?.screenshot_temperature))  ? Number(cfg.screenshot_temperature)  : screenshotTemperature);
      if (s.screenshotTokensInput) s.screenshotTokensInput.value = String(Number.isFinite(Number(cfg?.screenshot_max_tokens)) ? Number(cfg.screenshot_max_tokens)    : screenshotMaxTokens);
    } catch {}
    s.pop.style.display = 'block'; settingsVisible = true;
  }
  function hideSettings()   { if (settingsEl) { settingsEl.pop.style.display='none'; settingsVisible=false; } }
  function toggleSettings() { settingsVisible ? hideSettings() : openSettings(); }

  function resetWindowLayouts() {
    windowLayoutState = { answer:null, answerCustomized:false, history:null, chat:null, multi:null, logs:null, multiResized:false };
    safeStorageLocalRemove([WINDOW_STATE_KEY, WINDOW_STATE_ZONE_KEY, WINDOW_KEYS.answer, WINDOW_KEYS.history, WINDOW_KEYS.chat, WINDOW_KEYS.multi, WINDOW_KEYS.logs]);
    loadedLayoutZone  = widgetSide;
    answerUserResized = false;
    answerUserMoved   = false;
    const answerRect  = getDefaultRect('answer'),  historyRect = getDefaultRect('history');
    const chatRect    = getDefaultRect('chat'),    multiRect   = getDefaultRect('multi');
    // multi: null so fitToContent() uses DEFAULT mode (zone-bottom) — not CUSTOM mode
    // with an arbitrary default-rect y value.
    windowLayoutState = { answer:null, answerCustomized:false, history:historyRect, chat:chatRect, multi:null, logs:null, multiResized:false };
    if (we?.widget) {
      applyAnswerFrame(we.widget, {}, {});
      we.widget.style.minHeight = '0';
    }
    if (we?.historyPanel?.panel) applyRect(we.historyPanel.panel, historyRect, { width:historyRect.width, height:historyRect.height, minHeight:getWindowConfig('history').minH });
    if (we?.chatPanel?.panel)    applyRect(we.chatPanel.panel,    chatRect,    { width:chatRect.width,    height:chatRect.height,    minHeight:getWindowConfig('chat').minH    });
    if (me?.panel)               applyRect(me.panel,              multiRect,   { width:multiRect.width,   height:multiRect.height,   minHeight:getWindowConfig('multi').minH   });
    me?.resetUserFlags?.();   // clear in-memory move/resize flags so auto-size resumes this session
    we?.setZone?.(widgetSide);
    saveWindowLayoutState();
  }

  /* ═══ RUNTIME HELPERS ══════════════════════════════════════════════ */
  function runtimeOk() { try { return !isDestroyed && Boolean(chrome?.runtime?.id); } catch { return false; } }
  function ctxErr(e)   { return String(e?.message||e||'').toLowerCase().includes('extension context invalidated'); }
  function fmtErr(e)   { if (ctxErr(e)||!runtimeOk()) return ct('widget.context_stale'); return e?.message||'unknown error'; }

  async function safeSendMessage(payload) {
    if (!runtimeOk()) return null;
    try { return await chrome.runtime.sendMessage(payload); }
    catch (e) { if (ctxErr(e)) { isDestroyed = true; } return null; }
  }
  async function safeStorageLocalGet(keys, fallback = {}) {
    if (!runtimeOk()) return fallback;
    try { return await chrome.storage.local.get(keys); }
    catch (e) { if (ctxErr(e)) isDestroyed = true; return fallback; }
  }
  function safeStorageLocalSet(value) {
    if (!runtimeOk()) return Promise.resolve();
    return chrome.storage.local.set(value).catch(e => { if (ctxErr(e)) isDestroyed = true; });
  }
  function safeStorageLocalRemove(keys) {
    if (!runtimeOk()) return Promise.resolve();
    return chrome.storage.local.remove(keys).catch(e => { if (ctxErr(e)) isDestroyed = true; });
  }
  async function sendLog(msg, meta) { try { if (!runtimeOk()) return; await safeSendMessage({type:'LOG_ACTION',payload:{message:msg,meta}}); } catch {} }

  /* ═══ ANSWER FLOW ══════════════════════════════════════════════════ */
  async function runAnswerFlow(source = 'button', mode = 'answer', context = {}) {
    if (!extensionEnabled) return;
    let ctrl = null;
    try {
      // Consume the immutable selection/question snapshot before the first await.
      const q = getQuestionText(context.selectionSnapshot || null);
      const capturedQuestion = lastDetectedQuestion;
      const capturedSource = lastQuestionSource;
      qmLog('FLOW', 'Find activated', {
        source,
        questionChars:q.length,
        questionSource:capturedSource,
        hasVisual:Boolean(capturedQuestion?.hasVisual),
      });
      if (!q) { showAnswer(ct('widget.no_question_text')); return; }
      lastQuestionText = q;
      await layoutStateReady;
      await settingsReady;
      await sendLog('Find answer', { source, mode, questionChars:q.length, questionSource:capturedSource });
      if (!runtimeOk()) { showAnswer(ct('widget.context_stale')); return; }
      if (activeCtrl) activeCtrl.abort();
      ctrl = new AbortController(); activeCtrl = ctrl;
      showLoading();
      qmLog('FLOW', 'Answer request started', { source, questionChars:q.length, questionSource:capturedSource });
      const payload = { questionText:q, mode, source };
      if (currentModel) payload.model = currentModel;
      const answerPromise = capturedQuestion?.hasVisual
        ? requestYandexVisualAnswer(capturedQuestion, { silent:true, allowScroll:true, signal:ctrl.signal })
        : safeSendMessage({ type:'GET_ANSWER', payload });
      // Start MultiCheck pipeline immediately in parallel. Round-1 / Debate / Judge are
      // fully independent of the primary answer; only the final verdict comparison needs
      // it. primaryAnswerDeferred resolves to the answer string once GET_ANSWER returns
      // (or '' on failure), so the verdict is computed with the correct value regardless
      // of which side finishes first.
      if (multiCheckEnabled && !capturedQuestion?.hasVisual) {
        const primaryAnswerDeferred = answerPromise.then(res => res?.ok ? (res.answer || '') : '');
        runMultiCheck({ questionText:q, primaryAnswerDeferred, requestKind:'text' }).catch(() => {});
      }
      const r = await answerPromise;
      if (ctrl.signal.aborted) {
        if (we?.fl)     we.fl.style.display     = 'none';
        if (we?.loader) we.loader.style.display = 'none';
        return;
      }
      if (!r?.ok) throw new Error(r?.error || ct('widget.cant_get_answer'));
      qmLog('FLOW', 'Answer response received', { source, answerChars:String(r.answer || '').length });
      let applied = false;
      if (quizAutoApplyEnabled && capturedQuestion) {
        const result = await QM_QUIZ?.applyAnswerToQuestion(capturedQuestion, r.answer || '');
        applied = Boolean(result?.applied);
      }
      if (!applied) showAnswer(r.answer, currentModel || '');
      else showAnswer(`${ct('widget.answer_auto_applied')}\n${r.answer}`, currentModel || '');
      // MultiCheck is already running in parallel — no additional call needed here.
    } catch (e) {
      if (ctrl?.signal.aborted) {
        if (we?.fl)     we.fl.style.display     = 'none';
        if (we?.loader) we.loader.style.display = 'none';
        return;
      }
      showAnswer(`${ct('widget.error_prefix')}${fmtErr(e)}`);
    } finally {
      if (ctrl && activeCtrl === ctrl) activeCtrl = null;
    }
  }

  async function runYandexQuestionFlow() {
    if (!extensionEnabled) return;
    const question = window.__QM?.yandexForms?.resolveQuestion({
      selection:window.getSelection(),
      activeElement:document.activeElement,
      hoveredQuestion:QM_QUIZ?._lastHoveredQuestion,
    });
    if (!question) {
      showAnswer(ct('widget.no_yandex_question'));
      qmLog('FLOW', 'Yandex question hotkey failed', { reason:'no_unambiguous_question' });
      return;
    }

    lastDetectedQuestion = question;
    lastQuestionSource = 'yandex_hotkey';
    lastQuestionText = QM_QUIZ.buildStructuredPrompt(question);
    await layoutStateReady;
    await settingsReady;
    if (!runtimeOk()) { showAnswer(ct('widget.context_stale')); return; }
    if (activeCtrl) activeCtrl.abort();
    const ctrl = new AbortController();
    activeCtrl = ctrl;
    showLoading();
    qmLog('FLOW', 'Yandex question started', { type:question.type, hasVisual:question.hasVisual, questionChars:question.prompt.length });
    try {
      let response;
      if (question.hasVisual) {
        response = await requestYandexVisualAnswer(question, { silent:true, allowScroll:true, signal:ctrl.signal });
      } else {
        const course = await getCoursePackRequestContext(`${question.type}\n${question.prompt}`, 'yandex');
        const questionText = injectCourseContextIntoYandexText(lastQuestionText, course.context);
        const payload = { questionText, mode:'yandex_question' };
        if (currentModel) payload.model = currentModel;
        response = await safeSendMessage({ type:'GET_ANSWER', payload });
      }
      if (ctrl.signal.aborted) return;
      if (!response?.ok) throw new Error(response?.error || ct('widget.cant_get_answer'));
      let applied = false;
      if (quizAutoApplyEnabled) {
        const result = await QM_QUIZ.applyAnswerToQuestion(question, response.answer || '');
        applied = Boolean(result?.applied);
      }
      showAnswer(applied ? `${ct('widget.answer_auto_applied')}\n${response.answer}` : response.answer, response.model || currentModel || '');
      qmLog('FLOW', 'Yandex question answer received', { type:question.type, answerChars:String(response.answer || '').length, applied });
    } catch (error) {
      if (!ctrl.signal.aborted) {
        qmLog('FLOW', 'Yandex question request failed', { type:question.type, reason:String(error?.message || 'request_failed').slice(0, 100) });
        showAnswer(`${ct('widget.error_prefix')}${fmtErr(error)}`);
      }
    } finally {
      if (activeCtrl === ctrl) activeCtrl = null;
    }
  }

  /* ═══ DOCUMENT EVENTS ══════════════════════════════════════════════ */
  addManagedListener(document, 'mouseup',        () => window.setTimeout(showActionButton, 0));
  addManagedListener(document, 'keyup',          () => window.setTimeout(showActionButton, 0));
  addManagedListener(document, 'selectionchange',() => window.setTimeout(showActionButton, 0));
  addManagedListener(document, 'scroll',         hideActionButton, true);
  addManagedListener(document, 'mousedown', e => { if (actionButton && !actionButton.contains(e.target)) hideActionButton(); });

  addManagedListener(document, 'keydown', async e => {
    if (!e.isTrusted) return;
    if (e.composedPath?.()[0]?.dataset?.qmChatInput === 'true') return;
    if (e.key === 'Escape' && settingsVisible) { e.preventDefault(); hideSettings(); return; }
    if (matchHotkey(e, cachedHK.toggleExtension) && cachedHK.toggleExtension !== DEF_HK.toggleExtension) {
      e.preventDefault();
      await safeSendMessage({ type:'TOGGLE_EXTENSION_HOTKEY' });
      await refreshExtensionEnabled();
      return;
    }
    if (!extensionEnabled) return;
    if (matchHotkey(e, cachedHK.resetWindows)) { e.preventDefault(); resetWindowLayouts(); return; }
    if (matchHotkey(e, cachedHK.yandexQuestion) && isYandexFormsPage()) { e.preventDefault(); await runYandexQuestionFlow(); return; }
    if (matchHotkey(e, cachedHK.screenshot))   { e.preventDefault(); if (runtimeOk()) safeSendMessage({ type:'TRIGGER_SCREENSHOT_FROM_CONTENT' }); }
  }, true);

  addManagedListener(document, 'click', e => {
    if (!settingsVisible || !settingsEl?.pop) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(settingsEl.pop) && !path.includes(settingsHost)) hideSettings();
  }, true);

  /* ═══ MESSAGE LISTENER ═════════════════════════════════════════════ */
  addManagedChromeListener(chrome.runtime.onMessage, (msg, sender, sendResponse) => {
    if (msg?.type === 'EXTENSION_ENABLED_CHANGED') {
      refreshExtensionEnabled().then(() => sendResponse({ ok:true })).catch(() => sendResponse({ ok:false }));
      return true;
    }
    if (!extensionEnabled) {
      if (msg?.type === 'REQUEST_SCREENSHOT_SELECTION') { sendResponse({ ok:false, disabled:true }); return; }
      return false;
    }
    if (msg?.type === 'TRIGGER_QM_DOWNLOAD') {
      qmDownloadLog().then(ok => sendResponse({ ok: Boolean(ok) })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (msg?.type === 'TRIGGER_YANDEX_QUESTION') {
      runYandexQuestionFlow()
        .then(() => sendResponse({ ok:true }))
        .catch((error) => sendResponse({ ok:false, error:String(error?.message || 'Yandex question failed.') }));
      return true;
    }
    // Background service-worker log entries forwarded in real time to the Logs window.
    // Only reaches here when save_logs is on (TALogger._live guards the send side).
    if (msg?.type === 'BACKGROUND_LOG_ENTRY') {
      const { cat, msg: message, data } = msg.payload || {};
      qmLog(cat || 'FLOW', String(message || ''), data && typeof data === 'object' ? data : {});
      return;
    }
    if (msg?.type === 'toggle-widget' || msg?.type === 'TOGGLE_SETTINGS_PANEL') { toggleSettings(); return; }
    if (msg?.type === 'REQUEST_SCREENSHOT_SELECTION') {
      startManualScreenshotSelection().then(roi => sendResponse({ ok:true, roi, viewport:collectViewport(), questionText: lastQuestionText || '' }));
      return true;
    }
    if (msg?.type === 'SCREENSHOT_ANSWER_LOADING') { showLoading(); return; }
    if (msg?.type === 'SCREENSHOT_ANSWER_RESULT') {
      const p = msg.payload || {};
      if (p.ok) {
        /* Bind this task ID so the subsequent SCREENSHOT_MULTI_RESULT knows it belongs here.
           IMPORTANT: set taskId BEFORE showing loader — both happen in the same synchronous
           handler so there is zero race between taskId and loader visibility. */
        currentScreenshotTaskId = p.taskId || null;
        showAnswer(p.answer || ct('widget.empty_answer'), p.model || '');
        if (p.multiCheck?.willFollow) {
          /* Background confirmed image multicheck is about to start — show loader now.
             Triggered in the same handler as currentScreenshotTaskId assignment so the
             loader is always in sync with the task (no separate SCREENSHOT_MULTI_LOADING
             message needed). */
          const { placeLoader, mloader } = ensureMultiPanel();
          placeLoader?.();
          if (mloader) mloader.style.display = 'inline-flex';
        } else if (p.multiCheck?.used) {
          /* Legacy combined payload — handled for backward compatibility */
          const mc = p.multiCheck;
          showMultiResultPanel({
            question:  'Screenshot',
            original:  String(mc.originalAnswer || '').trim(),
            consensus: String(p.answer || '').trim(),
            accepted:  mc.verdict === 'correct',
            uncertain: mc.verdict === 'uncertain',
          });
        }
      } else {
        /* Screenshot failed — hide multi loader if it was shown for this task */
        if (me?.mloader) me.mloader.style.display = 'none';
        showAnswer(`${ct('widget.error_prefix')}${p.error || 'Could not process screenshot.'}`);
      }
    }
    if (msg?.type === 'SCREENSHOT_MULTI_RESULT') {
      const p = msg.payload || {};
      /* Always hide multi loader — multicheck is done regardless of outcome */
      if (me?.mloader) me.mloader.style.display = 'none';
      if (!p.ok) return false;
      /* Discard stale multicheck that belongs to a previous screenshot task */
      if (p.taskId && p.taskId !== currentScreenshotTaskId) return false;
      showMultiResultPanel({
        question:  'Screenshot',
        original:  String(p.originalAnswer || '').trim(),
        consensus: String(p.consensus || '').trim(),
        accepted:  p.verdict === 'correct',
        uncertain: p.verdict === 'uncertain',
      });
    }
    return false;
  });

  /* ═══ INIT ══════════════════════════════════════════════════════════ */

  /* Opens/closes the log panel via configurable hotkey (default Alt+L) */
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (e.composedPath?.()[0]?.dataset?.qmChatInput === 'true') return;
    if (matchHotkey(e, cachedHK.logs)) {
      e.preventDefault();
      toggleQmLogPanel();
    }
  }, true);

  if (extensionEnabled) ensureWidget();
  // Defer initWidgetFromStorage until both layout state and settings are fully loaded.
  // Widget is created immediately above for responsiveness; settings (zone, model, timer)
  // are applied once storage reads complete to avoid a transient wrong-zone flash.
  Promise.all([layoutStateReady, settingsReady])
    .catch(() => {})
    .then(() => initWidgetFromStorage());

  /* ═══ DESTROY ═══════════════════════════════════════════════════════ */
  function destroy() {
    if (isDestroyed) return;
    isDestroyed = true;
    chatFilePickerActive = false;
    try {
      activeCtrl?.abort?.(); activeCtrl = null;
      cleanupSS(); timerStop();
      clearTimeout(layoutSaveTimer);
      clearHighlights();
      WindowManager.hideWindow('answer',  { persist:false, stopTimer:true });
      WindowManager.hideWindow('history', { persist:false, stopTimer:true });
      WindowManager.hideWindow('chat',    { persist:false, stopTimer:true });
      WindowManager.hideWindow('multi',   { persist:false, stopTimer:true });
      WindowManager.hideWindow('logs',    { persist:false, stopTimer:true });
      WindowManager.destroyWindow('answer');
      WindowManager.destroyWindow('history');
      WindowManager.destroyWindow('chat');
      WindowManager.destroyWindow('multi');
      WindowManager.destroyWindow('logs');
      _QML?.destroy();
      actionButton?.remove?.();
      shadowHost?.remove?.();
      multiHost?.remove?.();
      settingsHost?.remove?.();
      selectionMaskStyleEl?.remove?.();
      QM_QUIZ?.ensureQuizScanObserver(false);
      for (const off of managedCleanups.splice(0)) { try { off(); } catch {} }
      actionButton = null; shadowHost = null; multiHost = null; settingsHost = null;
      settingsEl = null; we = null; me = null; selectionMaskStyleEl = null;
      screenshotSess = null; selectionSnapshot = null; settingsVisible = false;
      if (window.__QUIZMIND_ACTIVE_BUILD_ID__ === BUILD_ID) window.__QUIZMIND_ACTIVE_BUILD_ID__ = null;
      console.log('[QuizMind] content instance destroyed', BUILD_ID);
    } catch (e) { console.warn('[QuizMind] destroy failed', e); }
  }

  window.__QUIZMIND_INSTANCE__       = { buildId: BUILD_ID, destroy };
  window.__QUIZMIND_ACTIVE_BUILD_ID__ = BUILD_ID;
  console.log('[QuizMind] only one active instance', window.__QUIZMIND_ACTIVE_BUILD_ID__);
})();
