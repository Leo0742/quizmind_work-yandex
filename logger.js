/**
 * logger.js  —  TALogger
 *
 * Хранение логов: chrome.storage.local (основное хранилище).
 * Скачивание через chrome.downloads — ТОЛЬКО в трёх случаях:
 *   1. Размер данных в storage приближается к лимиту (авто-ротация).
 *   2. Service Worker выгружается (закрытие браузера / деактивация SW).
 *   3. Пользователь явно нажал «Download Logs».
 *
 * Поток данных:
 *   logAction / logError / logRequest
 *     → in-memory buffer (buf[])
 *       → flushToStorage()  (по таймеру / batch-порогу)
 *         → chrome.storage.local['taLogs']
 *           → downloadAndClear() / flushToFile() / downloadCurrentLogs()
 *             → chrome.downloads.download()  ← только по триггеру
 *
 * Ключи chrome.storage.local:
 *   taLoggerState  — { day, part }
 *   taLogs         — накопленный текст текущей части логов
 */

(() => {
  /* ─────────────────────── storage keys ───────────────────────────── */

  const STORAGE_STATE_KEY    = 'taLoggerState';
  const STORAGE_LOGS_KEY     = 'taLogs';
  const STORAGE_SCREENS_KEY  = 'taScreenshotQueue';

  /* ─────────────────────── thresholds ─────────────────────────────── */

  /**
   * chrome.storage.local квота = 5 242 880 байт (5 МБ).
   * Авто-скачивание начинается при 80% → ~4 194 304 байт.
   */
  const STORAGE_QUOTA_BYTES      = 5_242_880;
  const STORAGE_SOFT_LIMIT_BYTES = Math.floor(STORAGE_QUOTA_BYTES * 0.80);

  /** Сбрасываем буфер в storage раз в 15 с тишины. */
  const FLUSH_INTERVAL_MS = 15_000;

  /**
   * Максимальный суммарный размер очереди скриншотов (в байтах оценки base64).
   * При превышении — старые скриншоты вытесняются. ~2 МБ.
   */
  const SCREENSHOT_QUEUE_SOFT_LIMIT = 2_000_000;

  /** Максимальное количество скриншотов в очереди. */
  const SCREENSHOT_QUEUE_MAX_COUNT = 20;

  /** Немедленный flush после N строк в буфере. */
  const FLUSH_BATCH_LINES = 10;

  /* ─────────────────────── helpers: time ──────────────────────────── */

  function pad2(v) { return String(v).padStart(2, '0'); }

  function nowStamp(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
         + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function todayKey(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /* ─────────────────────── helpers: text ──────────────────────────── */

  function redactSensitiveText(value) {
    return String(value || '')
      .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(sk|rk)-[A-Za-z0-9_-]{16,}\b/g, '$1-[REDACTED]')
      .replace(/((?:api[_-]?key|authorization|cookie|csrf|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
      .replace(/(data:[^;,\s]+;base64,)[A-Za-z0-9+/=]{64,}/gi, '$1[REDACTED]');
  }

  function safeJson(v) {
    try { return redactSensitiveText(JSON.stringify(v)); } catch { return '{}'; }
  }

  function byteLength(text) {
    return new TextEncoder().encode(text || '').length;
  }

  function buildLine(level, message, meta) {
    const clean   = redactSensitiveText(message).replace(/\s+/g, ' ').trim();
    const metaStr = meta != null ? ` ${safeJson(meta)}` : '';
    return `[${nowStamp()}] [${level}] ${clean}${metaStr}`;
  }

  /* ─────────────────────── helpers: location ──────────────────────── */

  function normalizeLocation(loc) {
    return String(loc || 'MyExtensionLogs').trim().replace(/^\/+|\/+$/g, '') || 'MyExtensionLogs';
  }

  /* ─────────────────────── session state ──────────────────────────── */

  /**
   * Текущее состояние (day + part).
   * Объявлен ПЕРВЫМ чтобы все функции ниже могли безопасно его читать.
   */
  let st = { day: todayKey(), part: 1 };

  /* ─────────────────────── config & runtime state ─────────────────── */

  let cfg = { enabled: false, location: 'MyExtensionLogs', saveAs: false };

  /** Строки, ещё не сброшенные в storage. */
  let buf = [];

  /** Флаг: идёт ли прямо сейчас запись в storage (защита от гонок). */
  let isFlushing = false;

  /** ID таймера отложенного flush. */
  let flushTimer = null;

  /** Флаг: уже ли инициализировались в этой SW-сессии. */
  let isBootstrapped = false;

  /** Уникальный ID сессии для корреляции записей. */
  const SESSION_ID = Date.now().toString(36).toUpperCase();

  /**
   * Optional live-forward callback — set by background.js to relay structured
   * log entries to the active tab's content-script Logs window in real time.
   * Called with (cat, message, meta|null) only when cfg.enabled is true.
   * Must never throw; errors are swallowed.
   */
  let _liveCallback = null;

  /* ─────────────────────── state persistence ──────────────────────── */

  async function loadState() {
    const stored = (await chrome.storage.local.get([STORAGE_STATE_KEY]))[STORAGE_STATE_KEY] || {};
    return {
      day:  stored.day  || todayKey(),
      part: Number(stored.part) || 1
    };
  }

  async function saveState() {
    await chrome.storage.local.set({ [STORAGE_STATE_KEY]: { day: st.day, part: st.part } });
  }

  /* ─────────────────────── storage log helpers ────────────────────── */

  async function readStoredLogs() {
    const data = await chrome.storage.local.get([STORAGE_LOGS_KEY]);
    return String(data[STORAGE_LOGS_KEY] || '');
  }

  async function writeStoredLogs(text) {
    await chrome.storage.local.set({ [STORAGE_LOGS_KEY]: text });
  }

  async function clearStoredLogs() {
    await chrome.storage.local.remove([STORAGE_LOGS_KEY]);
  }

  /* ─────────────────────── screenshot queue ───────────────────────── */

  /**
   * Добавляет скриншот в очередь хранилища.
   * НЕ скачивает сразу — только при одном из трёх триггеров.
   * @param {string} filename  — путь для сохранения (напр. "MyExtensionLogs/screenshot_20250306_...jpg")
   * @param {string} dataUrl   — data URL изображения
   */
  async function queueScreenshot(filename, dataUrl) {
    if (!cfg.enabled) return;

    try {
      const data   = await chrome.storage.local.get([STORAGE_SCREENS_KEY]);
      const shots  = Array.isArray(data[STORAGE_SCREENS_KEY]) ? data[STORAGE_SCREENS_KEY] : [];

      shots.push({ filename, dataUrl, ts: Date.now() });

      /* Вытесняем старые записи если превышен лимит по количеству */
      while (shots.length > SCREENSHOT_QUEUE_MAX_COUNT) shots.shift();

      /* Вытесняем если суммарный размер base64 слишком большой */
      let totalBytes = shots.reduce((s, item) => s + (item.dataUrl?.length || 0), 0);
      while (shots.length > 1 && totalBytes > SCREENSHOT_QUEUE_SOFT_LIMIT) {
        const removed = shots.shift();
        totalBytes -= (removed.dataUrl?.length || 0);
      }

      await chrome.storage.local.set({ [STORAGE_SCREENS_KEY]: shots });
      queue(buildLine('ACTION', `Screenshot queued (pending download)`, { filename, total: shots.length }));
    } catch (e) {
      console.warn('[TALogger] queueScreenshot failed:', e);
    }
  }

  /**
   * Скачивает все скриншоты из очереди и очищает её.
   * Вызывается вместе с download-триггерами (не самостоятельно).
   */
  async function downloadQueuedScreenshots() {
    try {
      const data  = await chrome.storage.local.get([STORAGE_SCREENS_KEY]);
      const shots = Array.isArray(data[STORAGE_SCREENS_KEY]) ? data[STORAGE_SCREENS_KEY] : [];
      if (!shots.length) return;

      for (const item of shots) {
        try {
          await downloadFile(item.dataUrl, item.filename);
        } catch (e) {
          console.warn('[TALogger] screenshot download failed:', item.filename, e);
        }
      }

      await chrome.storage.local.remove([STORAGE_SCREENS_KEY]);
    } catch (e) {
      console.warn('[TALogger] downloadQueuedScreenshots failed:', e);
    }
  }

  /* ─────────────────────── download helper ────────────────────────── */

  /**
   * Скачивает файл (text или image data URL) через chrome.downloads.
   * Единая точка загрузки — вызывается ТОЛЬКО по триггеру.
   */
  async function downloadFile(url, filename) {
    if (!chrome?.downloads?.download) {
      throw new Error('chrome.downloads недоступен.');
    }
    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url, filename, saveAs: Boolean(cfg.saveAs), conflictAction: 'uniquify' },
        (id) => (chrome.runtime.lastError
          ? reject(new Error(chrome.runtime.lastError.message))
          : resolve(id))
      );
    });
  }

  /**
   * Скачивает текст как .log файл.
   * Вызывается ТОЛЬКО по одному из трёх триггеров — не при каждом flush.
   */
  async function downloadTextFile(text, filename) {
    const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
    return downloadFile(dataUrl, filename);
  }

  function makeFilename() {
    return `${normalizeLocation(cfg.location)}/logs_${st.day}_part${st.part}.log`;
  }

  /* ─────────────────────── download and clear ─────────────────────── */

  /**
   * Триггер №1: скачивает и очищает storage (авто-ротация по лимиту).
   * @param {string} [footer]       — маркер-строка в конец файла
   * @param {string} [textOverride] — готовый текст (не читаем storage повторно)
   */
  async function downloadAndClear(footer, textOverride) {
    let text = textOverride != null ? textOverride : await readStoredLogs();

    if (!text.trim()) return;

    if (footer) {
      text = `${text}\n${buildLine('INFO', footer)}`;
    }

    try {
      await downloadTextFile(text, makeFilename());
    } catch (e) {
      console.warn('[TALogger] downloadTextFile failed:', e);
    }

    await clearStoredLogs();
  }

  /* ─────────────────────── flush to storage ───────────────────────── */

  /**
   * Сбрасывает in-memory буфер в chrome.storage.local.
   * Downloads НЕ вызывается. Если storage близко к лимиту → downloadAndClear().
   */
  async function flushToStorage() {
    if (!cfg.enabled || !buf.length || isFlushing) return;

    isFlushing = true;

    try {
      const lines = buf.splice(0);   // атомарно забираем все строки
      const chunk = lines.join('\n');

      let stored = await readStoredLogs();

      /* Смена дня — финализируем старый файл */
      const today = todayKey();

      if (st.day !== today) {
        await downloadAndClear(`=== Day rollover → ${today} ===`);
        st.day  = today;
        st.part = 1;
        await saveState();
        stored = '';
      }

      const nextText  = stored ? `${stored}\n${chunk}` : chunk;
      const nextBytes = byteLength(nextText);

      if (nextBytes >= STORAGE_SOFT_LIMIT_BYTES) {
        /* Триггер №1: лимит storage → скачиваем, очищаем, новая часть */
        await downloadAndClear('=== Auto-rotate: storage limit reached ===', nextText);
        await downloadQueuedScreenshots();
        st.part += 1;
        await saveState();
        await writeStoredLogs(chunk);
      } else {
        await writeStoredLogs(nextText);
      }
    } catch (e) {
      console.warn('[TALogger] flushToStorage failed:', e);
    } finally {
      isFlushing = false;
    }
  }

  /* ─────────────────────── timer ──────────────────────────────────── */

  function clearFlushTimer() {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;

    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await flushToStorage();
    }, FLUSH_INTERVAL_MS);
  }

  /* ─────────────────────── queue ──────────────────────────────────── */

  function queue(line) {
    if (!cfg.enabled) return;

    buf.push(line);

    if (buf.length >= FLUSH_BATCH_LINES) {
      clearFlushTimer();
      flushToStorage();   // fire-and-forget; isFlushing защищает от гонок
      return;
    }

    scheduleFlush();
  }

  /* ─────────────────────── public: initLogger ─────────────────────── */

  async function initLogger(newSettings) {
    const nextEnabled  = Boolean(newSettings?.save_logs);
    const nextLocation = normalizeLocation(newSettings?.log_location);
    const nextSaveAs   = newSettings?.log_save_mode === 'save_as';
    const wasEnabled   = cfg.enabled;

    cfg = { enabled: nextEnabled, location: nextLocation, saveAs: nextSaveAs };

    if (!nextEnabled) {
      clearFlushTimer();
      if (wasEnabled && buf.length) await flushToStorage();
      return;
    }

    if (!isBootstrapped) {
      isBootstrapped = true;

      const loaded = await loadState();
      const today  = todayKey();

      st.day  = today;
      st.part = loaded.day === today
        ? loaded.part + 1   // тот же день — новая SW-сессия → новая часть
        : 1;                // новый день → сбрасываем счётчик

      await saveState();

      queue(buildLine('INFO', `=== Session ${SESSION_ID} started ===`, {
        day:  st.day,
        part: st.part
      }));
    } else if (!wasEnabled) {
      queue(buildLine('INFO', `Logging re-enabled (session ${SESSION_ID})`));
    }
  }

  /* ─────────────────────── public: log ───────────────────────────── */

  function _live(cat, message, meta) {
    if (!cfg.enabled || !_liveCallback) return;
    try {
      const safeMeta = meta == null ? null : JSON.parse(safeJson(meta));
      _liveCallback(cat, redactSensitiveText(message), safeMeta);
    } catch { /* never propagate */ }
  }

  function logAction(message, meta) {
    _live('FLOW', String(message || ''), meta ?? null);
    queue(buildLine('ACTION', message, meta));
  }

  function logRequest(data) {
    if (!data) return;

    if (data.type === 'text') {
      const preview = String(data.payloadPreview || '').slice(0, 200).replace(/\s+/g, ' ').trim();
      _live('AI', `type=text model=${data.model || '-'}`, { preview });
      queue(buildLine('REQUEST', `type=text model=${data.model || '-'}`, { preview }));
      return;
    }

    if (data.type === 'screenshot') {
      const meta = {
        model:  data.model  || '-',
        size:   `${data.width || '?'}x${data.height || '?'}`,
        bytes:  data.bytes  || 0,
        format: data.format || 'unknown'
      };
      _live('AI', 'type=screenshot', meta);
      queue(buildLine('REQUEST', 'type=screenshot', meta));
      return;
    }

    _live('AI', safeJson(data), null);
    queue(buildLine('REQUEST', safeJson(data)));
  }

  function logError(error, meta) {
    const msg = error?.message || String(error || 'Unknown error');
    _live('ERROR', msg, meta ?? null);
    queue(buildLine('ERROR', msg, meta));
  }

  /* ─────────────────────── public: flushToFile ────────────────────── */

  /**
   * Триггер №2: закрытие браузера (onSuspend).
   * Дописывает буфер в storage, затем скачивает.
   * НЕ очищает storage — браузер закрывается, очистка бессмысленна.
   */
  async function flushToFile() {
    if (!cfg.enabled) return '';

    /* Дописываем буфер в storage, обходя isFlushing */
    if (buf.length) {
      const lines = buf.splice(0);
      const chunk = lines.join('\n');

      try {
        const stored   = await readStoredLogs();
        const nextText = stored ? `${stored}\n${chunk}` : chunk;
        await writeStoredLogs(nextText);
      } catch { /* ignore — всё равно попробуем скачать */ }
    }

    try {
      const text = await readStoredLogs();
      if (!text.trim()) return '';
      const filename = makeFilename();
      await downloadTextFile(text, filename);
      /* Скачиваем скриншоты при закрытии браузера */
      await downloadQueuedScreenshots();
      return filename;
    } catch (e) {
      console.warn('[TALogger] flushToFile failed:', e);
      return '';
    }
  }

  /* ─────────────────────── public: downloadCurrentLogs ───────────── */

  /**
   * Триггер №3: пользователь нажал «Download Logs».
   * Flush → скачать → очистить storage → начать новую часть.
   */
  async function downloadCurrentLogs() {
    if (!cfg.enabled) return '';

    await flushToStorage();

    const text = await readStoredLogs();
    if (!text.trim()) return '';

    const filename = makeFilename();
    await downloadTextFile(text, filename);

    await clearStoredLogs();
    st.part += 1;
    await saveState();

    /* Скачиваем все накопленные скриншоты вместе с логами */
    await downloadQueuedScreenshots();

    queue(buildLine('INFO', `Logs downloaded by user → part ${st.part} started`));

    return filename;
  }

  /* ─────────────────────── public: meta ───────────────────────────── */

  function parseDataUrlMeta(dataUrl) {
    const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return { format: 'unknown', bytes: 0 };
    return { format: m[1] || 'unknown', bytes: Math.floor((m[2].length * 3) / 4) };
  }

  function getLoggerStatus() {
    return {
      enabled:        cfg.enabled,
      location:       cfg.location,
      sessionId:      SESSION_ID,
      buffered:       buf.length,
      day:            st.day,
      part:           st.part,
      softLimitBytes: STORAGE_SOFT_LIMIT_BYTES
    };
  }

  function formatTimestamp(d = new Date()) { return nowStamp(d); }

  /* ─────────────────────── export ─────────────────────────────────── */

  globalThis.TALogger = {
    initLogger,
    logAction,
    logRequest,
    logError,
    queueScreenshot,
    flushToFile,
    downloadCurrentLogs,
    parseDataUrlMeta,
    formatTimestamp,
    getLoggerStatus,
    /** Install a live-forward callback so background log entries are relayed to
     *  the content script's Logs window.  Pass null to remove.            */
    setLiveCallback(fn) { _liveCallback = typeof fn === 'function' ? fn : null; },
  };
})();
