/**
 * settingsStorage.js — обёртка над chrome.storage.local
 */
(() => {
  const STORAGE_KEY = 'taSettings';
  const DEFAULT_TEXT_MODEL = 'openai/gpt-5.5';
  const DEFAULT_VISION_MODEL = 'openai/gpt-5.5';
  const COURSE_PACK_SCHEMA = 'quizmind.coursepack.v1';
  const COURSE_PACK_STORAGE_KEYS = Object.freeze({
    pack: 'quizmind_course_pack_v1',
    enabled: 'quizmind_course_pack_enabled_v1',
    useChat: 'quizmind_course_pack_use_chat_v1',
    useYandex: 'quizmind_course_pack_use_yandex_v1',
  });
  const COURSE_PACK_MAX_FILE_BYTES = 8 * 1024 * 1024;
  const COURSE_PACK_MAX_LECTURES = 500;
  const COURSE_PACK_MAX_CHUNKS = 2000;
  const COURSE_PACK_MAX_SELECTED_CHUNKS = 8;
  const COURSE_PACK_MAX_CONTEXT_CHARS = 8000;
  const COURSE_PACK_INDEX_CACHE = new WeakMap();
  const COURSE_PACK_STOPWORDS = new Set([
    'a','an','and','are','as','at','be','by','for','from','has','have','how','in','is','it','of','on','or','that','the','this','to','was','what','when','where','which','who','why','with',
    'а','без','бы','был','была','были','быть','в','во','для','до','его','ее','её','если','есть','и','из','или','их','как','к','на','не','но','о','об','от','по','при','с','со','то','у','что','это','эта','эти',
  ]);

  const DEFAULT_SETTINGS = {
    provider:                 'routerai',
    model_text:               DEFAULT_TEXT_MODEL,
    model_vision:             DEFAULT_VISION_MODEL,
    model_favorites:          [],
    favorite_models:          [],
    auto_send_screenshot:     false,
    hotkey_text:              'Ctrl+Shift+Y / Cmd+Shift+Y',
    hotkey_screenshot:        'Ctrl+Shift+U / Cmd+Shift+U',
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
    screenshot_temperature:      0,
    screenshot_max_tokens:       500,
    widget_timer_ms:          5000,
    test_mode:                false,
    developer_mode:           false,
    active_zone:              'right',
    widget_position:          'right',
    widget_current_model:     DEFAULT_TEXT_MODEL,
    multi_check_enabled:      false,
    multi_check_models: [
      'qwen/qwen3-max-thinking',
      'deepseek/deepseek-v3.2',
      DEFAULT_TEXT_MODEL,
    ],
    screenshot_multi_check_models: [
      'google/gemini-3.1-flash-lite-preview',
      DEFAULT_VISION_MODEL,
    ],
    quiz_page_scan_enabled:    false,
    quiz_auto_apply_enabled:   false,
    quiz_show_answer_widget:   false,
    ui_language:               'auto',

    /* ── Theme settings ── */
    theme_enabled:             false,
    theme_scope:               'global',    // 'global' | 'per_surface'
    theme_global_preset:       'default',
    theme_global_custom:       {},
    theme_surfaces: {
      widget:   { preset: 'default', custom: {} },
      popup:    { preset: 'default', custom: {} },
      settings: { preset: 'default', custom: {} },
      inpage:   { preset: 'default', custom: {} },
    },
    chameleon_enabled:         false,
    chameleon_scope:           'widget_inpage', // 'widget_inpage' | 'all'
    chameleon_strength:        'medium',        // 'soft' | 'medium' | 'strong'
  };

  function withDefaults(raw) {
    const next = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    if (!next.provider || next.provider === 'auto') next.provider = 'routerai';
    const zone = next.active_zone || next.widget_position || 'right';
    next.active_zone = zone === 'left' ? 'left' : 'right';
    next.widget_position = next.active_zone;
    return next;
  }

  async function getSettings() {
    if (!chrome?.storage?.local) throw new Error('chrome.storage.local недоступен.');
    const data = await chrome.storage.local.get([STORAGE_KEY]);
    return withDefaults(data?.[STORAGE_KEY]);
  }

  async function setSettings(partial) {
    if (!chrome?.storage?.local) throw new Error('chrome.storage.local недоступен.');
    const current = await getSettings();
    const next    = withDefaults({ ...current, ...(partial || {}) });
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  }

  function coursePackError(code, detail = '') {
    const error = new Error(detail || code);
    error.code = code;
    return error;
  }

  function cleanCoursePackString(value, maxLength) {
    return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maxLength);
  }

  function cleanCoursePackKeywords(value) {
    const seen = new Set();
    const output = [];
    for (const item of Array.isArray(value) ? value : []) {
      const keyword = cleanCoursePackString(item, 80);
      const key = keyword.toLocaleLowerCase();
      if (!keyword || seen.has(key)) continue;
      seen.add(key);
      output.push(keyword);
      if (output.length >= 30) break;
    }
    return output;
  }

  function utf8ByteLength(value) {
    return new TextEncoder().encode(String(value || '')).byteLength;
  }

  function validateAndSanitizeCoursePack(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw coursePackError('invalid_object');
    if (raw.schema !== COURSE_PACK_SCHEMA) throw coursePackError('invalid_schema');
    const courseId = cleanCoursePackString(raw.courseId, 160);
    const title = cleanCoursePackString(raw.title, 300);
    if (!courseId) throw coursePackError('missing_course_id');
    if (!title) throw coursePackError('missing_title');
    if (!Array.isArray(raw.lectures) || !raw.lectures.length) throw coursePackError('missing_lectures');
    if (!Array.isArray(raw.chunks) || !raw.chunks.length) throw coursePackError('missing_chunks');
    if (raw.lectures.length > COURSE_PACK_MAX_LECTURES) throw coursePackError('too_many_lectures');
    if (raw.chunks.length > COURSE_PACK_MAX_CHUNKS) throw coursePackError('too_many_chunks');

    const lectureIds = new Set();
    const lectures = raw.lectures.map((lecture, index) => {
      if (!lecture || typeof lecture !== 'object' || Array.isArray(lecture)) throw coursePackError('invalid_lecture', String(index + 1));
      const lectureId = cleanCoursePackString(lecture.lectureId, 160);
      const lectureTitle = cleanCoursePackString(lecture.title, 300);
      if (!lectureId || !lectureTitle || lectureIds.has(lectureId)) throw coursePackError('invalid_lecture', String(index + 1));
      lectureIds.add(lectureId);
      const normalized = { lectureId, title:lectureTitle };
      const source = cleanCoursePackString(lecture.source, 300);
      const pages = Math.floor(Number(lecture.pages));
      if (source) normalized.source = source;
      if (Number.isFinite(pages) && pages > 0) normalized.pages = pages;
      return normalized;
    });
    const lectureById = new Map(lectures.map(lecture => [lecture.lectureId, lecture]));
    const chunkIds = new Set();
    const chunks = raw.chunks.map((chunk, index) => {
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw coursePackError('invalid_chunk', String(index + 1));
      const id = cleanCoursePackString(chunk.id, 180);
      const lectureId = cleanCoursePackString(chunk.lectureId, 160);
      const lecture = lectureById.get(lectureId);
      const lectureTitle = cleanCoursePackString(chunk.lectureTitle, 300) || lecture?.title || '';
      const page = Math.floor(Number(chunk.page));
      const text = cleanCoursePackString(chunk.text, 6000);
      const visualDescription = cleanCoursePackString(chunk.visualDescription, 3000);
      if (!id || chunkIds.has(id) || !lectureId || !lecture || !lectureTitle || !Number.isFinite(page) || page < 1 || (!text && !visualDescription)) {
        throw coursePackError('invalid_chunk', String(index + 1));
      }
      chunkIds.add(id);
      const normalized = { id, lectureId, lectureTitle, page };
      const source = cleanCoursePackString(chunk.source, 300) || lecture.source || '';
      const heading = cleanCoursePackString(chunk.heading, 500);
      const keywords = cleanCoursePackKeywords(chunk.keywords);
      if (source) normalized.source = source;
      if (heading) normalized.heading = heading;
      if (text) normalized.text = text;
      if (keywords.length) normalized.keywords = keywords;
      if (visualDescription) normalized.visualDescription = visualDescription;
      return normalized;
    });

    const pack = {
      schema: COURSE_PACK_SCHEMA,
      courseId,
      title,
      language:cleanCoursePackString(raw.language, 32) || 'unknown',
      createdAt:cleanCoursePackString(raw.createdAt, 40),
      lectures,
      chunks,
    };
    const description = cleanCoursePackString(raw.description, 2000);
    if (description) pack.description = description;
    if (!pack.createdAt) delete pack.createdAt;
    if (utf8ByteLength(JSON.stringify(pack)) > COURSE_PACK_MAX_FILE_BYTES) throw coursePackError('too_large');
    return pack;
  }

  function normalizeCoursePackText(value) {
    return String(value || '')
      .normalize('NFKD')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function tokenizeCoursePackText(value) {
    return [...new Set(normalizeCoursePackText(value).split(/\s+/).filter(token => token.length >= 2 && !COURSE_PACK_STOPWORDS.has(token)))];
  }

  function getCoursePackSearchIndex(pack) {
    const cached = COURSE_PACK_INDEX_CACHE.get(pack);
    if (cached) return cached;
    const index = pack.chunks.map(chunk => {
      const keywords = (chunk.keywords || []).map(normalizeCoursePackText).filter(Boolean);
      const heading = normalizeCoursePackText(chunk.heading);
      const lectureTitle = normalizeCoursePackText(chunk.lectureTitle);
      const text = normalizeCoursePackText(chunk.text);
      const visual = normalizeCoursePackText(chunk.visualDescription);
      return {
        chunk,
        keywords,
        heading,
        text,
        visual,
        keywordTokens:new Set(keywords.flatMap(tokenizeCoursePackText)),
        headingTokens:new Set(tokenizeCoursePackText(heading)),
        lectureTokens:new Set(tokenizeCoursePackText(lectureTitle)),
        textTokens:new Set(tokenizeCoursePackText(text)),
        visualTokens:new Set(tokenizeCoursePackText(visual)),
      };
    });
    COURSE_PACK_INDEX_CACHE.set(pack, index);
    return index;
  }

  function getRelevantCourseChunks(queryText, pack, options = {}) {
    if (!pack?.chunks?.length) return [];
    const query = normalizeCoursePackText(queryText);
    const tokens = tokenizeCoursePackText(query);
    if (!query || !tokens.length) return [];
    const maxChunks = Math.max(1, Math.min(COURSE_PACK_MAX_SELECTED_CHUNKS, Math.floor(Number(options.maxChunks) || COURSE_PACK_MAX_SELECTED_CHUNKS)));
    const maxChars = Math.max(500, Math.min(COURSE_PACK_MAX_CONTEXT_CHARS, Math.floor(Number(options.maxChars) || COURSE_PACK_MAX_CONTEXT_CHARS)));
    const scored = [];
    for (const entry of getCoursePackSearchIndex(pack)) {
      const { chunk, keywords, heading, text, visual, keywordTokens, headingTokens, lectureTokens, textTokens, visualTokens } = entry;
      let score = 0;
      for (const token of tokens) {
        if (keywordTokens.has(token)) score += 12;
        if (headingTokens.has(token)) score += 8;
        if (lectureTokens.has(token)) score += 5;
        if (visualTokens.has(token)) score += 3;
        if (textTokens.has(token)) score += 2;
      }
      for (const keyword of keywords) {
        if (keyword.length >= 3 && query.includes(keyword)) score += 16;
      }
      if (heading.length >= 5 && query.includes(heading)) score += 20;
      if (query.length >= 8 && (text.includes(query) || visual.includes(query))) score += 25;
      if (score > 0) scored.push({ chunk, score });
    }
    scored.sort((a, b) => b.score - a.score || a.chunk.page - b.chunk.page || a.chunk.id.localeCompare(b.chunk.id));
    const selected = [];
    const seen = new Set();
    let usedChars = 0;
    for (const item of scored) {
      if (seen.has(item.chunk.id)) continue;
      const estimatedChars = (item.chunk.text || '').length + (item.chunk.visualDescription || '').length + (item.chunk.heading || '').length + 160;
      if (selected.length && usedChars + estimatedChars > maxChars) continue;
      seen.add(item.chunk.id);
      selected.push({ ...item.chunk, score:item.score });
      usedChars += estimatedChars;
      if (selected.length >= maxChunks || usedChars >= maxChars) break;
    }
    return selected;
  }

  function formatCourseContextForPrompt(chunks, pack, options = {}) {
    if (!Array.isArray(chunks) || !chunks.length) return '';
    const maxChars = Math.max(500, Math.min(COURSE_PACK_MAX_CONTEXT_CHARS, Math.floor(Number(options.maxChars) || COURSE_PACK_MAX_CONTEXT_CHARS)));
    const header = [
      `COURSE MATERIALS — ${pack?.title || 'Course Pack'}`,
      'Use these course excerpts first. If they conflict with general knowledge, prefer the excerpts.',
      'If the excerpts do not clearly support an answer, state that the course materials do not clearly cover it.',
      'For quiz questions, choose the answer according to the course materials.',
    ].join('\n');
    let output = header;
    for (const [index, chunk] of chunks.entries()) {
      const metadata = [chunk.lectureTitle || chunk.lectureId, `page ${chunk.page}`, chunk.heading ? `"${chunk.heading}"` : '', chunk.source ? `source: ${chunk.source}` : ''].filter(Boolean).join(', ');
      const body = [chunk.text, chunk.visualDescription ? `Visual: ${chunk.visualDescription}` : ''].filter(Boolean).join('\n');
      const block = `\n\n[${index + 1}] ${metadata}\n${body}`;
      if (output.length + block.length > maxChars) {
        const remaining = maxChars - output.length;
        if (remaining > 200) output += block.slice(0, remaining).trimEnd();
        break;
      }
      output += block;
    }
    return output;
  }

  let cachedCoursePackState = null;

  async function getCoursePackState({ force = false } = {}) {
    if (!force && cachedCoursePackState) return cachedCoursePackState;
    const keys = Object.values(COURSE_PACK_STORAGE_KEYS);
    const data = await chrome.storage.local.get(keys);
    let pack = null;
    try { if (data[COURSE_PACK_STORAGE_KEYS.pack]) pack = validateAndSanitizeCoursePack(data[COURSE_PACK_STORAGE_KEYS.pack]); }
    catch { pack = null; }
    cachedCoursePackState = {
      pack,
      enabled:Boolean(data[COURSE_PACK_STORAGE_KEYS.enabled]) && Boolean(pack),
      useChat:data[COURSE_PACK_STORAGE_KEYS.useChat] !== false,
      useYandex:data[COURSE_PACK_STORAGE_KEYS.useYandex] !== false,
    };
    return cachedCoursePackState;
  }

  async function saveCoursePack(raw) {
    const pack = validateAndSanitizeCoursePack(raw);
    const state = await chrome.storage.local.get(Object.values(COURSE_PACK_STORAGE_KEYS));
    await chrome.storage.local.set({
      [COURSE_PACK_STORAGE_KEYS.pack]: pack,
      [COURSE_PACK_STORAGE_KEYS.enabled]: Boolean(state[COURSE_PACK_STORAGE_KEYS.enabled]),
      [COURSE_PACK_STORAGE_KEYS.useChat]: state[COURSE_PACK_STORAGE_KEYS.useChat] !== false,
      [COURSE_PACK_STORAGE_KEYS.useYandex]: state[COURSE_PACK_STORAGE_KEYS.useYandex] !== false,
    });
    cachedCoursePackState = null;
    return pack;
  }

  async function setCoursePackPreferences(partial = {}) {
    const current = await getCoursePackState({ force:true });
    const next = {
      enabled:partial.enabled === undefined ? current.enabled : Boolean(partial.enabled),
      useChat:partial.useChat === undefined ? current.useChat : Boolean(partial.useChat),
      useYandex:partial.useYandex === undefined ? current.useYandex : Boolean(partial.useYandex),
    };
    if (!current.pack) next.enabled = false;
    await chrome.storage.local.set({
      [COURSE_PACK_STORAGE_KEYS.enabled]: next.enabled,
      [COURSE_PACK_STORAGE_KEYS.useChat]: next.useChat,
      [COURSE_PACK_STORAGE_KEYS.useYandex]: next.useYandex,
    });
    cachedCoursePackState = null;
    return getCoursePackState({ force:true });
  }

  async function clearCoursePack() {
    await chrome.storage.local.remove(COURSE_PACK_STORAGE_KEYS.pack);
    await chrome.storage.local.set({ [COURSE_PACK_STORAGE_KEYS.enabled]:false });
    cachedCoursePackState = null;
  }

  async function getCourseContext(queryText, surface, options = {}) {
    const state = await getCoursePackState();
    const allowed = state.enabled && state.pack && (surface === 'chat' ? state.useChat : surface === 'yandex' ? state.useYandex : false);
    if (!allowed) return { context:'', chunks:[], pack:state.pack, enabled:false };
    const chunks = getRelevantCourseChunks(queryText, state.pack, options);
    return {
      context:formatCourseContextForPrompt(chunks, state.pack, options),
      chunks,
      pack:state.pack,
      enabled:true,
    };
  }

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (Object.values(COURSE_PACK_STORAGE_KEYS).some(key => changes[key])) cachedCoursePackState = null;
    });
  }

  globalThis.TASettingsStorage = { STORAGE_KEY, DEFAULT_SETTINGS, getSettings, setSettings };
  globalThis.TACoursePack = {
    COURSE_PACK_SCHEMA,
    COURSE_PACK_STORAGE_KEYS,
    COURSE_PACK_MAX_FILE_BYTES,
    COURSE_PACK_MAX_CHUNKS,
    COURSE_PACK_MAX_SELECTED_CHUNKS,
    COURSE_PACK_MAX_CONTEXT_CHARS,
    validateAndSanitizeCoursePack,
    getRelevantCourseChunks,
    formatCourseContextForPrompt,
    getCoursePackState,
    saveCoursePack,
    setCoursePackPreferences,
    clearCoursePack,
    getCourseContext,
  };
})();
