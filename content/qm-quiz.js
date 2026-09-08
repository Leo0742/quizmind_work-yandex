/**
 * qm-quiz.js  v1.0
 * QuizMind — quiz page scan engine (extracted from content.js).
 *
 * Self-contained: owns all internal quiz state.
 * External dependencies injected via window.__QM.quiz.init(ctx).
 *
 * Public API (window.__QM.quiz):
 *   init(ctx)                    — register context object
 *   get scanEnabled              — whether quiz scan is active
 *   ensureQuizScanObserver(bool) — start/stop the MutationObserver
 *   attachQuizHoverTracking()    — start hover-based prefetch
 *   detachQuizHoverTracking()    — stop hover-based prefetch
 *   scheduleQuizPrefetch(delay)  — schedule a scan
 *   extractQuestionData(el)      — parse a question container → object
 *   buildStructuredPrompt(q)     — format question for AI
 *   getNearestQuestionContainer(node) — walk DOM to find question block
 *
 * ctx must expose:
 *   .extensionEnabled       (bool getter)
 *   .quizScanEnabled        (bool getter)
 *   .quizAutoApplyEnabled   (bool getter)
 *   .quizShowAnswerWidget   (bool getter)
 *   .defaultTextModel       (string getter)
 *   .currentModel           (string getter)
 *   .lastSettingsModel      (string getter)
 *   .addManagedListener(...)
 *   .safeSendMessage(payload)
 *   .showAnswer(text, model)
 *   .qmLog(category, message, data?)
 *   .runtimeOk()
 *   .isDebugEnabled()
 */
(() => {
  'use strict';

  window.__QM = window.__QM || {};

  /* ── CONTEXT ─────────────────────────────────────────────────────────
   * All external dependencies. Populated by init(ctx) called from content.js.
   * ──────────────────────────────────────────────────────────────────── */
  let _ctx = null;

  /* ── QUIZ-INTERNAL STATE ─────────────────────────────────────────────
   * Moved from content.js lines 935-955 — all purely internal to quiz engine.
   * ──────────────────────────────────────────────────────────────────── */
  const YANDEX = window.__QM.yandexForms;
  const QUIZ_SCAN_SELECTORS = 'input[type="radio"],input[type="checkbox"],select,textarea,input[type="number"],input[type="text"],input:not([type]),[role="combobox"]';
  const QUIZ_CONTAINER_SELECTORS = '.QuestionMarkup.Question';
  const QUIZ_EXCLUDE_SELECTORS = '.quizmind-settings-shadow-host,.ta-helper-shadow-host,.quizmind-multi-shadow-host,[data-quizmind-ui],script,style,noscript,template';
  const QUIZ_SCAN_CACHE_TTL_MS = 2000;
  const QM_SCAN_PROGRESS_KEY = 'qm_scan_progress';
  let quizScanObserver = null;
  let quizScanDirty = true;
  let quizScanCache = { time: 0, containers: [] };
  let quizHoverActive = false;
  let lastHoveredQuestion = null;
  let quizPrefetchTimerId = null;
  let quizPrefetchActive = false;
  const QUIZ_PREFETCH_DELAY_MS = 120;
  const QUIZ_PREFETCH_BATCH_SIZE = 3;
  const QUIZ_PREFETCH_MAX_IN_FLIGHT = 3;
  const QUIZ_PREFETCH_PAGE_BUDGET = 60;
  const QUIZ_CACHE_MAX_ENTRIES = 200;
  const QUIZ_FAILED_RETRY_MS = 20_000;
  const QUIZ_MUTATION_IGNORE_MS = 3000; /* патч Г: увеличен с 1200 до 3000 */
  const quizAnswerCache = new Map();
  const quizInFlightRequests = new Map();
  const quizRequestedSignatures = new Set();
  const quizAppliedSignatureByContainer = new WeakMap();
  let quizIgnoreMutationsUntil = 0;

  /* ── LOCAL UTILITIES ─────────────────────────────────────────────────
   * Pure functions used only within the quiz engine.
   * Moved from content.js lines 958-985 (getElementDebugPath, truncateDebugText)
   * and 1122-1208 (quizLog, quizDebugLog).
   * ──────────────────────────────────────────────────────────────────── */
  function truncateDebugText(text, maxLen = 200) {
    const s = String(text || '');
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
  }

  function getElementDebugPath(el) {
    if (!el || !(el instanceof Element)) return '';
    try {
      const parts = [];
      let node = el;
      while (node && node !== document.body && parts.length < 6) {
        let part = node.tagName.toLowerCase();
        if (node.id) { part += '#' + node.id; parts.unshift(part); break; }
        if (node.className) {
          const cls = String(node.className).trim().split(/\s+/).slice(0, 2).join('.');
          if (cls) part += '.' + cls;
        }
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(' > ');
    } catch { return ''; }
  }

  function quizLog(scope, message, details = null, _level = 'log') {
    if (!isQuizDebugEnabled()) return;
    _ctx?.qmLog?.(scope, message, details ?? {});
  }

  function quizDebugLog(event, details = {}) { _ctx?.qmLog?.('APPLY', event, details); }

  /* ── QUIZ ENGINE FUNCTIONS ───────────────────────────────────────────
   * Extracted verbatim from content.js lines 1471-2721.
   * External deps replaced: extensionEnabled → _ctx.extensionEnabled, etc.
   * ──────────────────────────────────────────────────────────────────── */
  function normalizeQuizText(text = '') {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[•·▪►]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeComparableText(text, toLowerCase = true) {
    let t = String(text || '');
    if (toLowerCase) t = t.toLowerCase();
    return t
      .replace(/\n+/gi, '\n')
      .replace(/(\n\s*\n)+/g, '\n')
      .replace(/[ \t]+/gi, ' ')
      .trim()
      .replace(/^[a-z\d]\.\s/gi, '')
      .replace(/\n[a-z\d]\.\s/gi, '\n');
  }

  function normalizeCompareText(text = '') {
    return normalizeComparableText(normalizeQuizText(text), true)
      .replace(/[“'`´''””«»()\[\]{}:;!?]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isElementVisible(el) {
    if (!el || !(el instanceof Element) || el.closest(QUIZ_EXCLUDE_SELECTORS)) return false;
    return Boolean(YANDEX?.isVisible(el));
  }

  function isQuestionLikeContainer(container) {
    return Boolean(YANDEX?.isAnswerableQuestion(container));
  }

  function getNearestQuestionContainer(node) {
    return YANDEX?.closestQuestion(node) || null;
  }

  function toAlphaLabel(index) {
    const base = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (index < base.length) return base[index];
    return `A${index - base.length + 1}`;
  }

  /* ── Levenshtein distance used by fuzzy option matching ── */
  function levenshteinDistance(str1, str2) {
    if (str1.length === 0) return str2.length;
    if (str2.length === 0) return str1.length;
    const s1 = str1.replace(/\s+/g, '');
    const s2 = str2.replace(/\s+/g, '');
    const matrix = [];
    for (let i = 0; i <= s1.length; ++i) {
      matrix.push([i]);
      for (let j = 1; j <= s2.length; ++j) {
        matrix[i][j] = i === 0 ? j : Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + (s1[i - 1] === s2[j - 1] ? 0 : 1)
        );
      }
    }
    return matrix[s1.length][s2.length];
  }

  function levenshteinSimilarity(a, b) {
    const s1 = normalizeCompareText(String(a || ''));
    const s2 = normalizeCompareText(String(b || ''));
    if (!s1 && !s2) return 1;
    if (!s1 || !s2) return 0;
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1;
    return 1 - levenshteinDistance(s1, s2) / maxLen;
  }

  function textSimilarity(a, b) {
    const s1 = normalizeCompareText(a);
    const s2 = normalizeCompareText(b);
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1;
    const longer = s1.length > s2.length ? s1.length : s2.length;
    if (longer === 0) return 1;
    const levSim = (longer - levenshteinDistance(s1, s2)) / longer;
    /* Boost score when one string contains the other (important for long similar options) */
    if (s1.includes(s2) || s2.includes(s1)) return Math.max(levSim, 0.85);
    /* Word overlap score for long texts */
    if (longer > 30) {
      const w1 = new Set(s1.split(' ').filter(w => w.length > 2));
      const w2 = new Set(s2.split(' ').filter(w => w.length > 2));
      const overlap = [...w1].filter(w => w2.has(w)).length;
      const wordSim = overlap / Math.max(w1.size, w2.size, 1);
      return Math.max(levSim, wordSim * 0.9);
    }
    return levSim;
  }

  function extractTableText(tableEl) {
    if (!tableEl) return '';
    const rows = [];
    for (const row of tableEl.querySelectorAll('tr')) {
      if (!isElementVisible(row)) continue;
      const cells = [...row.querySelectorAll('th,td')]
        .map((cell) => normalizeQuizText(cell.textContent || ''))
        .filter(Boolean);
      if (cells.length) rows.push(`| ${cells.join(' | ')} |`);
    }
    return rows.join('\n');
  }

  function collectQuestionContainers() {
    const now = Date.now();
    if (!quizScanDirty && quizScanCache.containers.length && (now - quizScanCache.time) < QUIZ_SCAN_CACHE_TTL_MS) {
      const cached = quizScanCache.containers.filter((el) => el?.isConnected && isQuestionLikeContainer(el));
      _ctx.qmLog('SCAN', 'cache hit', { count: cached.length });
      return cached;
    }
    const seen = new Set();
    const out = [];
    const pushContainer = (container) => {
      if (!container || seen.has(container) || !isQuestionLikeContainer(container)) return;
      seen.add(container);
      out.push(container);
    };
    const ctrlHits = document.querySelectorAll(QUIZ_SCAN_SELECTORS);
    for (const block of YANDEX?.findQuestionRoots(document) || []) pushContainer(block);
    quizScanCache = { time: now, containers: out };
    quizScanDirty = false;
    _ctx.qmLog('SCAN', `found ${out.length} question containers`, {
      controlsScanned: ctrlHits.length,
      containerSelectors: out.slice(0, 8).map(el => (el.id ? '#'+el.id : '') + '.' + (el.className||'').split(' ').slice(0,2).join(' ')),
    });
    return out;
  }

  function resolveControlLabel(container, control) {
    const id = control.id;
    const byFor = (id && container.querySelector(`label[for="${CSS.escape(id)}"]`)) || null;
    const wrappingLabel = control.closest('label');
    const aria = control.getAttribute('aria-label') || control.getAttribute('title') || '';
    let nearbyText = '';
    const optionHost = control.closest('.answer,.r0,.r1,.option,.form-check,tr,li,.fitem,.ablock') || control.parentElement;
    if (optionHost) {
      const clone = optionHost.cloneNode(true);
      for (const noisy of clone.querySelectorAll('input,select,textarea,button,svg,img,.icon,.feedback,.state')) noisy.remove();
      nearbyText = normalizeQuizText(clone.textContent || '');
      if (nearbyText.length > 180) nearbyText = '';
    }
    const sibling = normalizeQuizText(control.parentElement?.textContent || '');
    const siblingSafe = sibling.length <= 120 ? sibling : '';
    const ownValue = String(control.value || '').trim();
    const fallbackValue = (ownValue && ownValue.toLowerCase() !== 'on') ? ownValue : '';
    return normalizeQuizText(byFor?.textContent || wrappingLabel?.textContent || aria || nearbyText || siblingSafe || fallbackValue || '');
  }

  function extractSelectPerRow(container) {
    const rows = [];
    const selects = [...container.querySelectorAll('select')].filter((s) => isElementVisible(s));
    if (selects.length < 2) return rows;
    for (const select of selects) {
      const row = select.closest('tr,li,.row,.answer,.option,div') || select.parentElement;
      if (!row) continue;
      const clone = row.cloneNode(true);
      for (const childSelect of clone.querySelectorAll('select')) childSelect.remove();
      const rowText = normalizeQuizText(clone.textContent || '');
      const options = [...select.options].map((opt, idx) => ({
        key: `${select.name || select.id || 'select'}:${idx}`,
        label: toAlphaLabel(idx),
        text: normalizeQuizText(opt.textContent || ''),
        value: opt.value,
        control: select,
        kind: 'select-option',
      })).filter((o) => o.text);
      if (!options.length) continue;
      rows.push({ rowText, control: select, options });
    }
    return rows;
  }

  function extractOptionsFromContainer(container) {
    return YANDEX?.extractOptions(container) || [];
  }

  function detectType(container, options, selectRows) {
    return YANDEX?.detectType(container, options) || 'unsupported';
  }

  function extractQuestionData(container) {
    const question = YANDEX?.extractQuestion(container) || null;
    if (question) quizLog('SCAN', `Extracted question (${question.type})`, { domPath: getElementDebugPath(container), prompt: truncateDebugText(question.prompt, 260), options: question.options.map((o) => o.text), hasVisual: question.hasVisual });
    return question;
  }

  function buildStructuredPrompt(question) {
    return YANDEX?.buildStructuredPrompt(question) || '';
  }

  function findBestQuestionFromSelection() {
    return YANDEX?.resolveQuestion({ selection:window.getSelection(), activeElement:document.activeElement, hoveredQuestion:lastHoveredQuestion }) || null;
  }

  function parseAnswerTokens(raw = '') {
    return String(raw || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .split(/[\n,;]+/)
      .map((x) => normalizeQuizText(x.replace(/^[\-•*\s]+/, '')))
      .filter(Boolean);
  }


  function cleanupAnswerText(raw = '') {
    const cleaned = normalizeQuizText(String(raw || ''));
    if (!cleaned) return '';
    return cleaned
      .replace(/^(?:final\s*answer|answer|ответ\s*на\s*вопрос|ответ|правильный\s*ответ|correct\s*answer|текст\s*вопроса|текст\s*ответа|answer\s*text|question\s*text|question)\s*[:\-–—]*\s*/i, '')
      .replace(/^['"`]+|['"`]+$/g, '')
      .trim();
  }

  function isGenericAnswerText(text = '') {
    const t = normalizeCompareText(text);
    if (!t) return true;
    return /^(?:ответ\s*на\s*вопрос|ответ|текст\s*вопроса|текст\s*ответа|question\s*text|question|final\s*answer|answer|answer\s*text|your\s*answer|the\s*answer)$/i.test(t);
  }

  function isLikelyAnswerLabelToken(token = '') {
    const t = normalizeQuizText(token);
    if (!t) return true;
    if (/^[A-Za-zА-Яа-яЁё]$/.test(t)) return true;
    if (/^[A-Za-zА-Яа-яЁё]\)$/.test(t)) return true;
    if (/^\d+[\)\.]$/.test(t)) return true;
    if (/^(?:option|вариант|answer)\s*[A-Za-zА-Яа-яЁё\d]?$/i.test(t)) return true;
    return false;
  }

  function sanitizeAnswerCandidate(candidate = '') {
    let text = cleanupAnswerText(candidate);
    text = text
      .replace(/^[A-Za-zА-Яа-яЁё]\)\s+/, '')
      .replace(/^\d+[\)\.]\s+/, '')
      .replace(/^(?:option|вариант)\s*[A-Za-zА-Яа-яЁё\d]\s*[:\-–—]\s*/i, '')
      .replace(/^(?:option|вариант|answer)\s*[:\-–—]\s*/i, '')
      .trim();
    if (!text) return '';
    if (isGenericAnswerText(text)) return '';
    if (isLikelyAnswerLabelToken(text)) return '';
    return text;
  }

  function extractFinalAnswerText(raw = '', context = {}) {
    const lineCandidates = String(raw || '').split(/\n+/)
      .map((line) => sanitizeAnswerCandidate(line))
      .filter(Boolean);

    const tokenCandidates = parseAnswerTokens(raw)
      .map((x) => sanitizeAnswerCandidate(x))
      .filter(Boolean);

    const candidates = [...lineCandidates, ...tokenCandidates];
    if (candidates.length) {
      const qType = String(context?.questionType || '').toLowerCase();
      const preferNumeric = qType === 'numeric';
      const preferLonger = qType === 'text' || qType === 'rich_text' || qType === 'unknown';
      const preferred = candidates
        .sort((a, b) => {
          if (preferNumeric) {
            const aNum = /^-?\d+(?:[\.,]\d+)?$/.test(a) ? 0 : 1;
            const bNum = /^-?\d+(?:[\.,]\d+)?$/.test(b) ? 0 : 1;
            if (aNum !== bNum) return aNum - bNum;
          }
          return preferLonger ? b.length - a.length : a.length - b.length;
        })
        .find((x) => x.length >= 1);
      if (preferred) return preferred;
    }

    const fallback = sanitizeAnswerCandidate(raw);
    return fallback || '';
  }


  function normalizeNumericAnswerCandidate(text = '') {
    const cleaned = normalizeQuizText(text);
    if (!cleaned) return '';
    if (/^[oо]$/i.test(cleaned)) return '0';
    return cleaned;
  }

  function parseMappingLines(raw = '') {
    const lines = String(raw || '').split(/\n+/).map((line) => normalizeQuizText(line)).filter(Boolean);
    return lines.map((line) => {
      const m = line.match(/^(.*?)\s*(?:=>|->|:|=)\s*(.+)$/);
      if (!m) return null;
      return { row: normalizeQuizText(m[1]), value: normalizeQuizText(m[2]) };
    }).filter(Boolean);
  }

  function pickOptionByToken(options, token, minScore = 0.58) {
    const norm = normalizeCompareText(token);
    if (!norm) return null;

    const exact = options.find((opt) => normalizeCompareText(opt.label) === norm || normalizeCompareText(opt.text) === norm);
    if (exact) return { opt: exact, score: 1, confident: true };

    let best = null;
    let second = null;
    for (const opt of options) {
      const candidate = `${opt.label} ${opt.text}`;
      const score = Math.max(textSimilarity(opt.text, norm), textSimilarity(candidate, norm));
      if (!best || score > best.score) {
        second = best;
        best = { opt, score };
      } else if (!second || score > second.score) {
        second = { opt, score };
      }
    }
    if (!best || best.score < minScore) return null;
    if (second && Math.abs(best.score - second.score) < 0.07) return null;
    return { ...best, confident: true };
  }

  function setNativeValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(input, value);
    else input.value = value;
  }

  function dispatchInputEvents(el, context = {}) {
    if (!el?.isConnected) return;
    const dispatched = { keydown: false, keyup: false, input: false, change: false, blur: false };
    try { dispatched.keydown = el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' })); }
    catch (error) { quizLog('ERROR', 'Failed to dispatch keydown', { error, context }, 'error'); }
    try { dispatched.input = el.dispatchEvent(new Event('input', { bubbles: true })); }
    catch (error) { quizLog('ERROR', 'Failed to dispatch input', { error, context }, 'error'); }
    try { dispatched.keyup = el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' })); }
    catch (error) { quizLog('ERROR', 'Failed to dispatch keyup', { error, context }, 'error'); }
    try { dispatched.change = el.dispatchEvent(new Event('change', { bubbles: true })); }
    catch (error) { quizLog('ERROR', 'Failed to dispatch change', { error, context }, 'error'); }
    try { dispatched.blur = el.dispatchEvent(new Event('blur', { bubbles: true })); }
    catch (error) { quizLog('ERROR', 'Failed to dispatch blur', { error, context }, 'error'); }
    for (const eventName of ['input', 'change', 'keydown', 'keyup', 'blur']) {
      quizLog('EVENT', `${eventName} dispatched`, { signature: context.signature || '', selector: context.selector || '', ok: dispatched[eventName] });
    }
  }

  function getTextInputCandidates(question) {
    const container = question?.container;
    if (!container?.isConnected) return [];
    const selectors = [
      'input[name$="_answer"]',
      'input[name$=":answer"]',
      'input[name*="_answer"]',
      'input[name*=":answer"]',
      'textarea',
      'input[type="text"]',
      'input[type="search"]',
      'input[type="tel"]',
      'input[type="email"]',
      'input[type="url"]',
      'input:not([type])',
    ];
    const seen = new Set();
    const result = [];
    for (const selector of selectors) {
      for (const node of container.querySelectorAll(selector)) {
        if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) continue;
        if (seen.has(node)) continue;
        seen.add(node);
        const type = String(node.type || '').toLowerCase();
        if (['hidden', 'radio', 'checkbox', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color', 'date', 'datetime-local', 'month', 'time', 'week'].includes(type)) continue;
        if (!isElementVisible(node)) continue;
        result.push({ selector, field: node });
      }
    }
    return result;
  }

  function getPrimaryTextInputCandidate(question) {
    const candidates = getTextInputCandidates(question);
    if (!candidates.length) return null;
    const strict = candidates.find((candidate) => {
      const name = String(candidate.field?.name || '');
      return name.endsWith('_answer') || name.endsWith(':answer');
    });
    return strict || candidates[0];
  }

  function writeTextValueWithVerification(field, answerText, context = {}) {
    if (!field?.isConnected) {
      quizLog('ERROR', 'Failed to find input field', { reason: 'missing-field', signature: context.signature || '' }, 'error');
      return { applied: false, reason: 'missing-field' };
    }
    const valueToWrite = String(answerText ?? '');
    const before = String(field.value ?? '');
    /* Skip write entirely when the field already holds the target value.
       Avoids unnecessary DOM mutation + event dispatch that would re-arm the observer. */
    if (before === valueToWrite) {
      quizLog('APPLY', 'Text value already correct, skip write', { value: valueToWrite, signature: context.signature || '' });
      return { applied: true, reason: 'already-correct' };
    }
    const beforeAttr = String(field.getAttribute('value') ?? '');
    const fieldMeta = {
      signature: context.signature || '',
      selector: context.selector || '',
      fieldName: String(field.name || ''),
      fieldId: String(field.id || ''),
      fieldType: String(field.type || field.tagName || '').toLowerCase(),
      readonly: Boolean(field.readOnly),
      disabled: Boolean(field.disabled),
    };
    quizLog('DOM', 'Target element selected', { selector: context.selector || getElementDebugPath(field), path: getElementDebugPath(field), elementType: field.tagName.toLowerCase() });
    const attemptSet = (phase = 'write') => {
      try { field.focus(); } catch (error) { quizLog('ERROR', 'Focus failed', { error, ...fieldMeta }, 'error'); }
      try { field.value = valueToWrite; } catch (error) { quizLog('ERROR', 'Direct value set failed', { error, ...fieldMeta }, 'error'); }
      try { setNativeValue(field, valueToWrite); } catch (error) { quizLog('ERROR', 'Native value set failed', { error, ...fieldMeta }, 'error'); }
      try { if (field.getAttribute('value') !== valueToWrite) field.setAttribute('value', valueToWrite); } catch (error) { quizLog('ERROR', 'Attribute value set failed', { error, ...fieldMeta }, 'error'); }
      dispatchInputEvents(field, { ...fieldMeta, phase });
    };
    quizLog('APPLY', 'Writing text value', { before, attempted: valueToWrite, signature: context.signature || '' });
    attemptSet('first');
    let after = String(field.value ?? '');
    let afterAttr = String(field.getAttribute('value') ?? '');
    if (after !== valueToWrite || afterAttr !== valueToWrite) {
      attemptSet('retry');
      after = String(field.value ?? '');
      afterAttr = String(field.getAttribute('value') ?? '');
    }
    /* Primary check: .value property — this is what the user sees in the field.
       The getAttribute('value') attribute reflects the HTML default value and may
       not update synchronously when the page's state handler or a MutationObserver
       resets it in response to dispatched events. Requiring both to match caused
       false 'verify-failed' returns even when the field was visually correct. */
    const verified = after === valueToWrite;
    quizLog('VERIFY', verified ? 'SUCCESS' : `FAILED → value reset to "${truncateDebugText(after)}"`, {
      ...fieldMeta,
      cacheSignature: context.cacheSignature || '',
      before,
      beforeAttr,
      attempted: valueToWrite,
      after,
      afterAttr,
      verified,
    });
    if (!verified) return { applied: false, reason: 'verify-failed' };

    window.setTimeout(() => {
      if (!field?.isConnected) return;
      const now = String(field.value ?? '');
      const nowAttr = String(field.getAttribute('value') ?? '');
      if (now === valueToWrite) return;   /* value property matches — field is correctly filled */
      quizLog('OVERWRITE', 'Detected overwrite → reapplying', { ...fieldMeta, attempted: valueToWrite, now, nowAttr }, 'warn');
      try {
        field.value = valueToWrite;
        setNativeValue(field, valueToWrite);
        if (field.getAttribute('value') !== valueToWrite) field.setAttribute('value', valueToWrite);
        dispatchInputEvents(field, { ...fieldMeta, phase: 'delayed-reapply' });
      } catch (error) {
        quizLog('ERROR', 'Delayed reapply failed', { error, ...fieldMeta }, 'error');
      }
    }, 220);

    return { applied: true, reason: 'text' };
  }

  function isPreparedAnswerApplied(question, preparedAnswer) {
    if (!question?.container?.isConnected) return false;
    const normalizedPrepared = String(preparedAnswer || '');
    if (['text', 'rich_text', 'unknown', 'numeric'].includes(String(question.type || ''))) {
      const primary = getPrimaryTextInputCandidate(question);
      if (primary && String(primary.field.value ?? '') === normalizedPrepared) return true;
      const candidates = getTextInputCandidates(question);
      for (const candidate of candidates) {
        if (String(candidate.field.value ?? '') === normalizedPrepared) return true;
      }
      return false;
    }
    return false;
  }

  function setNativeChecked(input, checked) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'checked');
    if (desc?.set) desc.set.call(input, Boolean(checked));
    else input.checked = Boolean(checked);
  }

  function applyCheckedState(control, shouldCheck) {
    if (!control?.isConnected) return false;
    const target = Boolean(shouldCheck);
    const before = Boolean(control.checked);
    quizLog('DOM', 'Target element selected', { path: getElementDebugPath(control), elementType: control.type || control.tagName.toLowerCase() });
    if (before !== target && (control.disabled || control.readOnly)) return false;
    if (before !== target) {
      try { control.click(); } catch (error) { quizLog('ERROR', 'Click failed', { error, path: getElementDebugPath(control) }, 'error'); }
    }
    // Yandex controls are real native inputs. Respect the result of the normal
    // click so form-level maximum-choice and validation rules cannot be bypassed.
    if (Boolean(control.checked) !== target) return false;
    quizLog('APPLY', 'Checked state applied', { before, after: Boolean(control.checked), target });
    /* Only dispatch events when the state actually changed — skip when already correct
       to avoid unnecessary DOM mutations that would re-arm the MutationObserver. */
    if (before !== target) dispatchInputEvents(control);
    return before !== target;
  }

  async function applyAnswerToQuestion(question, rawAnswer) {
    if (!question?.container?.isConnected) return { applied: false, reason: 'stale-question' };
    quizIgnoreMutationsUntil = Date.now() + QUIZ_MUTATION_IGNORE_MS;
    const signature = getQuestionSignature(question);
    const tokens = parseAnswerTokens(rawAnswer);
    const options = (question.options || []).filter((o) => o.control?.isConnected);
    quizLog('APPLY', 'Applying answer to question', { signature, type: question.type, tokens, rawAnswer: truncateDebugText(rawAnswer, 800) });

    if (question.type === 'single_choice' || question.type === 'true_false') {
      const token = tokens[0] || rawAnswer;
      for (const opt of options) {
        const jac = textSimilarity(opt.text, token);
        const lev = levenshteinSimilarity(opt.text, token);
        quizLog('MATCH', `Option "${truncateDebugText(opt.text, 120)}"`, { label: opt.label, jaccardOrLexical: jac, levenshtein: lev });
      }
      const best = pickOptionByToken(options, token, 0.65);
      if (!best) return { applied: false, reason: 'low-confidence' };
      quizLog('MATCH', 'Selected option', { label: best.opt.label, text: best.opt.text, score: best.score });
      applyCheckedState(best.opt.control, true);
      return Boolean(best.opt.control.checked) ? { applied: true, reason: question.type } : { applied: false, reason: 'set-radio-failed' };
    }

    if (question.type === 'multi_choice') {
      const picks = tokens.map((t) => pickOptionByToken(options, t, 0.6)).filter(Boolean);
      if (!picks.length) return { applied: false, reason: 'low-confidence' };
      const picked = new Set(picks.map((x) => x.opt));
      let valid = 0;
      for (const opt of options) {
        const shouldCheck = picked.has(opt);
        quizLog('MATCH', `Option "${truncateDebugText(opt.text, 120)}"`, { shouldCheck });
        applyCheckedState(opt.control, shouldCheck);
        if (Boolean(opt.control.checked) === shouldCheck) valid += 1;
      }
      return valid === options.length ? { applied: true, reason: 'multi_choice' } : { applied: false, reason: 'set-checkbox-failed' };
    }

    if (question.type === 'select') {
      if (question.combobox) {
        const token = tokens[0] || rawAnswer;
        return YANDEX.applyComboboxOption(question.combobox, token, pickOptionByToken);
      }
      const selectControls = [...new Set(options.map((o) => o.control).filter(Boolean))];
      let appliedCount = 0;
      for (let i = 0; i < selectControls.length; i++) {
        const select = selectControls[i];
        const token = tokens[i] || tokens[0] || rawAnswer;
        const localOptions = options.filter((o) => o.control === select);
        const best = pickOptionByToken(localOptions, token, 0.62);
        if (!best) continue;
        quizLog('MATCH', 'Select matched option', { token: truncateDebugText(token, 120), selected: best.opt.text, score: best.score });
        select.value = best.opt.value;
        dispatchInputEvents(select, { signature, selector: getElementDebugPath(select) });
        appliedCount += 1;
      }
      return appliedCount ? { applied: true, reason: 'select' } : { applied: false, reason: 'low-confidence' };
    }

    if (question.type === 'select_per_row') {
      const mappings = parseMappingLines(rawAnswer);
      let appliedCount = 0;
      for (const row of question.selectRows || []) {
        const mapping = mappings.find((m) => textSimilarity(m.row, row.rowText) >= 0.55) || mappings[appliedCount] || null;
        const token = mapping?.value || tokens[appliedCount] || tokens[0] || rawAnswer;
        const best = pickOptionByToken(row.options, token, 0.62);
        if (!best) continue;
        quizLog('MATCH', 'Select-per-row matched', { row: truncateDebugText(row.rowText, 160), token, selected: best.opt.text });
        row.control.value = best.opt.value;
        dispatchInputEvents(row.control, { signature, selector: getElementDebugPath(row.control) });
        appliedCount += 1;
      }
      return appliedCount ? { applied: true, reason: 'select_per_row' } : { applied: false, reason: 'low-confidence' };
    }

    if (question.type === 'numeric') {
      const primary = getPrimaryTextInputCandidate(question);
      const input = primary?.field || question.container.querySelector('input[type="number"],input[inputmode="numeric"],input[type="text"]');
      if (!input) return { applied: false, reason: 'no-input' };
      const cleanAnswer = normalizeNumericAnswerCandidate(extractFinalAnswerText(rawAnswer, { questionType: 'numeric' }));
      const num = (String(cleanAnswer).match(/-?\d+(?:[\.,]\d+)?/) || [])[0];
      if (!num) return { applied: false, reason: 'no-number' };
      quizLog('MATCH', 'Numeric extracted', { cleanAnswer, final: num.replace(',', '.') });
      return writeTextValueWithVerification(input, num.replace(',', '.'), {
        signature,
        selector: primary?.selector || 'input[type="number"],input[inputmode="numeric"],input[type="text"]',
      });
    }

    if (question.type === 'text' || question.type === 'long_text') {
      const editable = question.container.querySelector('[contenteditable="true"],iframe[title*="editor" i]');
      /* extractFinalAnswerText strips answers that match isLikelyAnswerLabelToken (e.g. "12.", "A").
         Fall back to cleanupAnswerText which only strips "Answer:" prefixes, no label filtering.
         However, if the fallback itself is still a label token (e.g. "N"), reject it — do not
         insert single-letter/placeholder model outputs into open-ended text fields. */
      const _cleanFallback = cleanupAnswerText(String(rawAnswer || ''));
      const answerText = extractFinalAnswerText(rawAnswer, { questionType: 'text' })
        || (!isLikelyAnswerLabelToken(_cleanFallback) ? _cleanFallback : '');
      quizLog('MATCH', 'Final text answer prepared', { cleaned: answerText, raw: truncateDebugText(String(rawAnswer || ''), 120) });
      if (!answerText) return { applied: false, reason: 'empty-answer' };
      if (isGenericAnswerText(answerText)) return { applied: false, reason: 'generic-answer' };
      const primary = getPrimaryTextInputCandidate(question);
      if (primary) {
        return writeTextValueWithVerification(primary.field, answerText, { signature, selector: primary.selector });
      }
      if (editable?.tagName === 'IFRAME') {
        const body = editable.contentDocument?.body;
        if (!body) return { applied: false, reason: 'iframe-unavailable' };
        body.innerHTML = '';
        body.textContent = answerText;
        dispatchInputEvents(body, { signature, selector: getElementDebugPath(body) });
        return { applied: true, reason: 'rich_text_iframe' };
      }
      if (editable) {
        editable.focus();
        editable.textContent = answerText;
        dispatchInputEvents(editable, { signature, selector: getElementDebugPath(editable) });
        return { applied: true, reason: 'rich_text' };
      }
      quizLog('ERROR', 'No writable field for text answer', { signature }, 'error');
      return { applied: false, reason: 'no-text-target' };
    }

    if (question.type === 'cloze') {
      const subs = question.clozeSubQuestions || [];
      if (!subs.length) return { applied: false, reason: 'no-cloze-controls' };
      let appliedCount = 0;
      for (let i = 0; i < subs.length; i++) {
        const sub = subs[i];
        const token = tokens[i] || tokens[0] || rawAnswer;
        quizLog('SCAN', `Cloze sub-question #${i + 1}`, { kind: sub.kind, contextBefore: sub.contextBefore, contextAfter: sub.contextAfter, options: sub.options || [] });
        if (!sub.control?.isConnected) continue;
        if (sub.kind === 'select') {
          const selectEl = sub.control;
          const selectOpts = [...selectEl.options].map((o, idx) => ({ key: `cloze-select-${i}:${idx}`, label: toAlphaLabel(idx), text: normalizeQuizText(o.textContent || ''), value: o.value, control: selectEl, kind: 'select-option' })).filter((o) => o.text);
          const best = pickOptionByToken(selectOpts, token, 0.55);
          if (best) {
            quizLog('MATCH', 'Cloze select matched', { subIndex: i + 1, token, selected: best.opt.text, score: best.score });
            selectEl.value = best.opt.value;
            dispatchInputEvents(selectEl, { signature, selector: getElementDebugPath(selectEl) });
            appliedCount += 1;
          }
        } else {
          const answerText = sanitizeAnswerCandidate(token);
          if (answerText && !isGenericAnswerText(answerText)) {
            const result = writeTextValueWithVerification(sub.control, answerText, { signature, selector: `cloze-text-${i}` });
            if (result.applied) appliedCount += 1;
          }
        }
      }
      return appliedCount ? { applied: true, reason: 'cloze' } : { applied: false, reason: 'cloze-no-match' };
    }

    return { applied: false, reason: 'unsupported' };
  }

  function ensureQuizScanObserver(enabled) {
    if (!enabled) {
      if (quizScanObserver) {
        try { quizScanObserver.disconnect(); } catch (error) { quizLog('ERROR', 'Observer disconnect failed', { error }, 'error'); }
        quizScanObserver = null;
      }
      if (quizPrefetchTimerId) {
        window.clearTimeout(quizPrefetchTimerId);
        quizPrefetchTimerId = null;
      }
      const cleaned = { observer: true, cacheSize: quizAnswerCache.size, inFlightSize: quizInFlightRequests.size };
      quizPrefetchActive = false;
      quizAnswerCache.clear();
      quizInFlightRequests.clear();
      quizRequestedSignatures.clear();
      quizScanDirty = true;
      quizScanCache = { time: 0, containers: [] };
      lastHoveredQuestion = null;
      detachQuizHoverTracking();
      quizLog('CLEANUP', 'Quiz Page Scan disabled and cleaned', cleaned);
      return;
    }
    if (quizScanObserver || !document.documentElement) return;
    const markDirty = (records = []) => {
      const hasNewQuestionNodes = records.some((record) => record.type === 'childList'
        && [...record.addedNodes].some((node) => node instanceof Element
          && (node.matches?.(QUIZ_CONTAINER_SELECTORS) || node.querySelector?.(QUIZ_CONTAINER_SELECTORS))));
      // Suppress answer-application churn, but never drop a conditional/new-page
      // question that appeared during that short quiet period.
      if (Date.now() < quizIgnoreMutationsUntil && !hasNewQuestionNodes) return;
      quizScanDirty = true;
      if (_ctx.quizScanEnabled && _ctx.extensionEnabled) scheduleQuizPrefetch(420);
    };
    quizScanObserver = new MutationObserver(markDirty);
    try {
      quizScanObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled', 'readonly'],
      });
      quizLog('SCAN', 'Mutation observer attached');
    } catch (error) {
      quizScanObserver = null;
      quizLog('ERROR', 'Mutation observer attach failed', { error }, 'error');
    }
  }


  function getQuestionSignature(question) {
    if (!question) return '';
    const promptKey = normalizeCompareText(String(question.prompt || '').slice(0, 600));
    if (!promptKey) return '';
    const fieldKey = normalizeCompareText(String(question.fieldSignature || '').slice(0, 300));
    const signature = `${promptKey}|${question.type || 'unknown'}|${(question.options || []).length}|${fieldKey}`;
    quizLog('CACHE', `Signature: ${truncateDebugText(signature, 180)}`);
    return signature;
  }

  function getQuizScanModel() {
    return String(_ctx.defaultTextModel || _ctx.currentModel || _ctx.lastSettingsModel || '').trim();
  }

  function reportScanProgress() {
    if (!_ctx.quizScanEnabled) return;
    const all     = quizAnswerCache.size;
    const ready   = [...quizAnswerCache.values()].filter(e => e.status === 'ready').length;
    const pending = [...quizAnswerCache.values()].filter(e => e.status === 'pending').length;
    try {
      chrome.storage.local.set({ [QM_SCAN_PROGRESS_KEY]: { ready, pending, total: all, ts: Date.now() } });
    } catch {}
  }

  function cachePreparedAnswer(question, answer, status = 'ready') {
    const signature = getQuestionSignature(question);
    if (!signature) return;
    const existing = quizAnswerCache.get(signature) || {};
    if (!quizAnswerCache.has(signature) && quizAnswerCache.size >= QUIZ_CACHE_MAX_ENTRIES) {
      const oldest = [...quizAnswerCache.entries()].find(([, entry]) => entry.status !== 'pending');
      if (oldest) quizAnswerCache.delete(oldest[0]);
    }
    quizAnswerCache.delete(signature);
    quizAnswerCache.set(signature, {
      ...existing,
      signature,
      status,
      answer: String(answer || ''),
      updatedAt: Date.now(),
      question,
    });
    reportScanProgress();
  }

  async function prefetchQuestionAnswer(question) {
    if (!_ctx.quizScanEnabled || !_ctx.extensionEnabled || !question) return;
    if (!_ctx.runtimeOk()) return;
    const signature = getQuestionSignature(question);
    if (!signature) return;

    const cached = quizAnswerCache.get(signature);
    const now = Date.now();
    quizLog('CACHE', `Signature: ${signature}`);
    if (cached?.status === 'ready') {
      quizLog('CACHE', 'HIT (ready)', { signature });
      return;
    }
    if (cached?.status === 'failed' && (now - Number(cached.updatedAt || 0)) < QUIZ_FAILED_RETRY_MS) {
      quizLog('CACHE', 'Recent FAILED cached, skipping retry', { signature, ageMs: now - Number(cached.updatedAt || 0) });
      return;
    }
    if (quizInFlightRequests.has(signature)) {
      quizLog('CACHE', 'In-flight dedup hit', { signature });
      return quizInFlightRequests.get(signature);
    }
    if (!quizRequestedSignatures.has(signature) && quizRequestedSignatures.size >= QUIZ_PREFETCH_PAGE_BUDGET) {
      quizLog('ERROR', 'Per-page scan request budget reached', { limit: QUIZ_PREFETCH_PAGE_BUDGET }, 'warn');
      return;
    }
    if (quizInFlightRequests.size >= QUIZ_PREFETCH_MAX_IN_FLIGHT) return;

    quizRequestedSignatures.add(signature);
    quizAnswerCache.set(signature, { signature, status: 'pending', answer: '', updatedAt: now, question });
    quizLog('CACHE', 'MISS → sending request', { signature });

    const reqPromise = (async () => {
      const prompt = buildStructuredPrompt(question);
      const payload = { questionText: prompt, mode: 'answer' };
      const model = getQuizScanModel();
      if (model) payload.model = model;
      quizLog('REQUEST', 'Model request', {
        model: model || '(default)',
        endpoint: 'chrome.runtime.sendMessage type=GET_ANSWER',
        prompt: truncateDebugText(prompt, 1200),
        body: { ...payload, questionText: truncateDebugText(payload.questionText, 400) },
      });
      const r = question.hasVisual && typeof _ctx.requestVisualAnswer === 'function'
        ? await _ctx.requestVisualAnswer(question, { silent:true, allowScroll:false })
        : await _ctx.safeSendMessage({ type: 'GET_ANSWER', payload });
      if (!r?.ok) {
        quizAnswerCache.set(signature, { signature, status: 'failed', answer: '', updatedAt: Date.now(), question });
        quizLog('ERROR', 'Model request failed', { signature, response: r }, 'error');
        return;
      }
      quizLog('RESPONSE', 'Raw response received', { signature, raw: truncateDebugText(String(r.answer || ''), 1200) });
      /* extractFinalAnswerText intentionally strips single-letter tokens (isLikelyAnswerLabelToken)
         because for text fields "A" is not a valid answer. For choice types however the apply path
         (tryApplyPreparedAnswer) uses entry.answer directly — not extractFinalAnswerText — so
         logging parsed="" for "A" is misleading. Use raw answer as the logged finalAnswer for
         choice types to keep the log consistent with what the runtime actually uses. */
      const CHOICE_LOG_TYPES = ['single_choice', 'true_false', 'multi_choice', 'select', 'select_per_row', 'cloze'];
      const parsed = CHOICE_LOG_TYPES.includes(String(question.type || ''))
        ? (r.answer || '')
        : extractFinalAnswerText(r.answer || '', { questionType: String(question.type || '') });
      const candidates = parseAnswerTokens(r.answer || '');
      quizLog('RESPONSE', 'Parsed response', { signature, candidates, finalAnswer: parsed });
      if (['text', 'numeric', 'rich_text', 'unknown'].includes(String(question.type || ''))) {
        const qType = String(question.type || '');
        if (qType === 'numeric') {
          /* Numeric: must have an extractable number to be useful */
          const prepared = normalizeNumericAnswerCandidate(extractFinalAnswerText(r.answer || '', { questionType: 'numeric' }));
          if (!prepared) {
            quizAnswerCache.set(signature, { signature, status: 'failed', answer: '', updatedAt: Date.now(), question });
            quizLog('ERROR', 'Prepared answer empty after parse', { signature, qType, raw: r.answer }, 'error');
            return;
          }
        } else if (!r.answer?.trim()) {
          /* text/rich_text/unknown: only fail on a genuinely empty AI response.
             Even if extractFinalAnswerText returns '' (e.g. AI returned a short
             single-letter token that isLikelyAnswerLabelToken filters), store the
             raw answer as 'ready' so the helper window appears and the apply stage
             can attempt to use rawAnswer directly. */
          quizAnswerCache.set(signature, { signature, status: 'failed', answer: '', updatedAt: Date.now(), question });
          quizLog('ERROR', 'Empty AI response for text question', { signature, qType }, 'error');
          return;
        }
      }
      cachePreparedAnswer(question, r.answer || '', 'ready');
      if (_ctx.quizAutoApplyEnabled) {
        await tryApplyPreparedAnswer(question);
      } else if (lastHoveredQuestion?.container?.isConnected) {
        const hoveredSignature = getQuestionSignature(lastHoveredQuestion);
        if (hoveredSignature && hoveredSignature === signature) {
          tryApplyPreparedAnswer(lastHoveredQuestion).catch((error) => quizLog('ERROR', 'Prepared answer apply failed', { error }, 'error'));
        }
      }
    })().catch((error) => {
      quizAnswerCache.set(signature, { signature, status: 'failed', answer: '', updatedAt: Date.now(), question });
      quizLog('ERROR', 'Model request exception', { signature, error }, 'error');
    }).finally(() => {
      quizInFlightRequests.delete(signature);
    });

    quizInFlightRequests.set(signature, reqPromise);
    return reqPromise;
  }

  async function runQuizPrefetchScan() {
    if (!_ctx.quizScanEnabled || !_ctx.extensionEnabled) {
      _ctx.qmLog('SCAN', 'runQuizPrefetchScan SKIP', { quizScanEnabled: _ctx.quizScanEnabled, extensionEnabled: _ctx.extensionEnabled, quizPrefetchActive });
      return;
    }
    if (quizPrefetchActive) {
      // A mutation can arrive while the previous batch is finishing. Preserve
      // that dirty signal instead of dropping the only scheduled follow-up.
      scheduleQuizPrefetch(250);
      return;
    }
    // A scheduled continuation must still inspect the container list: with the
    // bounded three-request batch there may be untouched questions even when no
    // new DOM mutation occurred since the previous batch.
    quizPrefetchActive = true;
    quizScanDirty = false;   /* reset before scan so mutations that arrive during the scan re-arm it */
    _ctx.qmLog('SCAN', '🔍 runQuizPrefetchScan START', {});
    const widget = _ctx.getWidgetElements?.();
    if (widget?.scanBtn) {
      const cached = [...quizAnswerCache.values()].filter(e => e.status === 'ready').length;
      widget.scanBtn.title = `Quiz Scan: сканирование... | ${cached} кешировано`;
    }
    try {
      ensureQuizScanObserver(true);
      const containers = collectQuestionContainers();
      _ctx.qmLog('SCAN', `containers found: ${containers.length}`, {
        ids: containers.slice(0, 8).map(el => el.id || el.className.split(' ').slice(0, 2).join('.') || '?'),
      });
      if (!containers.length) { _ctx.qmLog('SCAN', '⚠️ no containers — check selectors', {}); return; }
      let launched = 0, skipped = 0;
      for (const container of containers) {
        if (launched >= QUIZ_PREFETCH_BATCH_SIZE) break;
        if (quizInFlightRequests.size >= QUIZ_PREFETCH_MAX_IN_FLIGHT) break;
        const q = extractQuestionData(container);
        if (!q) { skipped++; continue; }
        const signature = getQuestionSignature(q);
        if (!signature) { skipped++; continue; }
        const cached = quizAnswerCache.get(signature);
        if (cached?.status === 'ready' || cached?.status === 'pending') {
          skipped++;   /* counted in SCAN DONE summary; no per-item log to avoid noise */
          continue;
        }
        if (!quizRequestedSignatures.has(signature) && quizRequestedSignatures.size >= QUIZ_PREFETCH_PAGE_BUDGET) {
          skipped++;
          continue;
        }
        launched += 1;
        _ctx.qmLog('SCAN', `launching prefetch ${launched}`, { type: q.type, sig: signature.slice(0, 60) });
        prefetchQuestionAnswer(q).catch(() => {});
      }
      _ctx.qmLog('SCAN', `✅ runQuizPrefetchScan DONE`, { launched, skipped, total: containers.length });
      /* Update scan button tooltip with counts */
      if (widget?.scanBtn) widget.scanBtn.title = `Quiz Scan: ${containers.length} вопросов | ${launched} в очереди | ${skipped} кешировано`;
      /* Only reschedule if we actually launched something OR DOM changed (dirty).
         Do NOT reschedule just from hover movement. */
      if (launched > 0) scheduleQuizPrefetch(800);
      else if (quizScanDirty) scheduleQuizPrefetch(400);
      /* else: everything cached, stop rescanning */
    } finally {
      quizPrefetchActive = false;
    }
  }

  function scheduleQuizPrefetch(delay = QUIZ_PREFETCH_DELAY_MS) {
    if (!_ctx.quizScanEnabled || !_ctx.extensionEnabled) return;
    if (quizPrefetchTimerId) return;   /* already scheduled — first schedule wins, avoid log spam */
    const safeDelay = Math.max(50, Number(delay) || QUIZ_PREFETCH_DELAY_MS);
    quizLog('PREFETCH', 'Scheduling prefetch', { delayMs: safeDelay });
    quizPrefetchTimerId = window.setTimeout(() => {
      quizPrefetchTimerId = null;
      runQuizPrefetchScan().catch((error) => quizLog('ERROR', 'Prefetch scan failed', { error }, 'error'));
    }, safeDelay);
  }

  function isQuizDebugEnabled() { return _ctx.isDebugEnabled(); }

  function questionGroupLabel(question, signature) {
    return `[QM:Apply] ${question?.type || '?'} | ${String(signature || '').slice(0, 60)}`;
  }

  async function tryApplyPreparedAnswer(question) {
    if (!_ctx.quizScanEnabled || !question?.container?.isConnected) {
      quizLog('HOVER', 'Apply skipped', { reason: 'scan-disabled-or-stale' });
      return false;
    }
    const signature = getQuestionSignature(question);
    const groupLabel = questionGroupLabel(question, signature);
    if (isQuizDebugEnabled()) console.groupCollapsed(groupLabel);
    try {
      if (!signature) {
        quizLog('HOVER', 'Apply skipped', { reason: 'empty-signature' });
        return false;
      }
      quizLog('SCAN', `Found question (${question.type})`, {
        signature,
        domPath: getElementDebugPath(question.container),
        text: truncateDebugText(question.prompt, 400),
        options: (question.options || []).map((o) => o.text),
      });
      const entry = quizAnswerCache.get(signature);
      if (!entry || entry.status !== 'ready' || !entry.answer) {
        quizLog('HOVER', 'Cache MISS on hover', { signature, cacheStatus: entry?.status || 'none' });
        prefetchQuestionAnswer(question).catch((error) => quizLog('ERROR', 'Hover-triggered prefetch failed', { signature, error }, 'error'));
        return false;
      }
      quizLog('HOVER', 'Cache HIT on hover', { signature, answer: truncateDebugText(entry.answer, 300) });
      if (!_ctx.quizAutoApplyEnabled) {
        if (_ctx.quizShowAnswerWidget) _ctx.showAnswer(entry.answer, _ctx.currentModel || '');
        quizLog('HOVER', 'Auto Apply disabled; answer left untouched', { signature });
        return false;
      }
      /* Choice types (radio/checkbox/select/cloze) use raw AI answer as the "prepared"
         value — single-letter labels like "A","B","True" would be stripped to '' by
         sanitizeAnswerCandidate/isLikelyAnswerLabelToken, causing a false early-return
         before applyAnswerToQuestion is ever reached.
         isPreparedAnswerApplied() only checks text fields, so using raw answer here is safe. */
      const qType = String(question.type || '');
      const CHOICE_TYPES = ['single_choice', 'true_false', 'multi_choice', 'select', 'select_per_row', 'cloze'];
      const prepared = CHOICE_TYPES.includes(qType)
        ? (entry.answer || '')
        : qType === 'numeric'
          ? normalizeNumericAnswerCandidate(extractFinalAnswerText(entry.answer, { questionType: 'numeric' }))
          /* text/rich_text/unknown: extractFinalAnswerText may strip short answers that match
             isLikelyAnswerLabelToken patterns (e.g. "12." "/^\d+[\)\.]$/" or single chars like "A").
             Fall back to cleanupAnswerText which only strips leading "Answer:" prefixes — no label filtering. */
          : (extractFinalAnswerText(entry.answer, { questionType: qType || 'text' })
              || cleanupAnswerText(String(entry.answer || '')));
      if (!prepared) {
        quizLog('HOVER', 'Apply skipped', { reason: 'empty-prepared-answer', signature, qType });
        return false;
      }
      const appliedSignature = quizAppliedSignatureByContainer.get(question.container);
      if (appliedSignature === signature && isPreparedAnswerApplied(question, prepared)) {
        quizLog('HOVER', 'Apply skipped (already applied)', { signature, prepared });
        return false;
      }
      quizLog('HOVER', 'Applying answer', { signature, prepared });
      const result = await applyAnswerToQuestion(question, entry.answer);
      if (!result?.applied) {
        quizLog('VERIFY', 'FAILED', { signature, reason: result?.reason || 'unknown' }, 'warn');
        return false;
      }
      quizLog('VERIFY', 'SUCCESS', { signature, reason: result?.reason || 'ok' });
      quizAppliedSignatureByContainer.set(question.container, signature);
      return true;
    } catch (error) {
      quizLog('ERROR', 'Apply pipeline failed', { error, signature }, 'error');
      return false;
    } finally {
      if (isQuizDebugEnabled()) console.groupEnd();
    }
  }

  function detachQuizHoverTracking() {
    quizHoverActive = false;
    quizLog('CLEANUP', 'Hover tracking detached');
  }

  function attachQuizHoverTracking() {
    if (quizHoverActive) return;

    /* Throttled hover — runs at most once per 180ms AND only when container changes */
    let _hoverThrottleTimer = null;
    let _hoverLastContainer = null;
    let _hoverLastHighlight = null;

    const processHover = (target) => {
      if (!_ctx.quizScanEnabled || !_ctx.extensionEnabled) return;
      const container = getNearestQuestionContainer(target);
      if (!container) return;
      /* Skip if same container as last time — nothing changed */
      if (container === _hoverLastContainer) return;
      _hoverLastContainer = container;

      const q = extractQuestionData(container);
      if (!q) return;
      const signature = getQuestionSignature(q);
      quizDebugLog('hover-question', { signature, type: q.type, targetTag: target?.tagName || '' });
      lastHoveredQuestion = q;

      const entry = quizAnswerCache.get(signature);
      /* The classList operations below modify the 'class' attribute, which is in the
         MutationObserver's attributeFilter. Without this guard they would fire markDirty(),
         set quizScanDirty=true, and schedule a useless 420ms rescan.
         For the ready→apply path, applyAnswerToQuestion re-sets this window anyway.
         For the pending path, this is the only guard. */
      quizIgnoreMutationsUntil = Date.now() + QUIZ_MUTATION_IGNORE_MS;
      /* Visual highlight */
      if (_hoverLastHighlight && _hoverLastHighlight !== container) {
        _hoverLastHighlight.classList.remove('qm-q-hover', 'qm-q-pending');
      }
      _hoverLastHighlight = container;

      if (entry?.status === 'ready' && entry.answer) {
        container.classList.add('qm-q-hover');
        setTimeout(() => container.classList.remove('qm-q-hover'), 800);
        _ctx.qmLog('HOVER', 'hover → ready → apply', { sig: signature.slice(0, 60), type: q.type });
        if (!_ctx.quizScanEnabled || _ctx.quizShowAnswerWidget) _ctx.showAnswer(entry.answer, _ctx.currentModel || '');
        tryApplyPreparedAnswer(q).catch((error) => quizLog('ERROR', 'Hover apply failed', { error }, 'error'));
      } else {
        container.classList.add('qm-q-pending');
        _ctx.qmLog('HOVER', 'hover → ' + (entry?.status || 'not cached') + ' → prefetch', {
          sig: signature.slice(0, 60), type: q.type,
        });
        prefetchQuestionAnswer(q).catch(() => {});
      }
    };

    const updateHoveredQuestion = (event) => {
      if (!_ctx.quizScanEnabled || !_ctx.extensionEnabled) return;
      if (_hoverThrottleTimer) return;   /* still in throttle window */
      _hoverThrottleTimer = setTimeout(() => { _hoverThrottleTimer = null; }, 180);
      processHover(event?.target);
    };

    _ctx.addManagedListener(document, 'pointerover', updateHoveredQuestion, { passive: true, capture: true });
    _ctx.addManagedListener(document, 'mousemove',   updateHoveredQuestion, { passive: true, capture: true });
    quizHoverActive = true;
  }


  /* ── PUBLIC API ──────────────────────────────────────────────────────
   * Used by content.js to drive the quiz scan engine.
   * ──────────────────────────────────────────────────────────────────── */
  window.__QM.quiz = {
    /**
     * Register the context object — must be called by content.js before any
     * other quiz API is used. ctx exposes content.js state via getters.
     */
    init(ctx) { _ctx = ctx; },

    /** True when quiz scan is active (reads from ctx.quizScanEnabled). */
    get scanEnabled() { return _ctx?.quizScanEnabled ?? false; },

    /* Engine entry points — called by content.js */
    ensureQuizScanObserver,
    attachQuizHoverTracking,
    detachQuizHoverTracking,
    scheduleQuizPrefetch,

    /* Used by content.js's getQuestionText() bridge function */
    extractQuestionData,
    buildStructuredPrompt,
    getNearestQuestionContainer,
    findBestQuestionFromSelection,
    isQuestionLikeContainer,
    collectQuestionContainers,
    getQuestionSignature,
    pickOptionByToken,
    parseAnswerTokens,
    applyAnswerToQuestion,

    /** Read-only access to internal hover state for getQuestionText bridge */
    get _lastHoveredQuestion() { return lastHoveredQuestion; },

    /* Default prefetch delay (used by content.js in refreshCache) */
    get PREFETCH_DELAY_MS() { return QUIZ_PREFETCH_DELAY_MS; },
  };

})();
