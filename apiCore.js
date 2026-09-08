/**
 * apiCore.js — Shared API core (service worker only)
 *
 * RouterAI backend: https://routerai.ru/api/v1
 * RouterAI is OpenAI Chat Completions compatible, so the existing text and
 * screenshot pipelines can keep their current `messages` format.
 *
 * Public API used by background.js / answerEngine.js / screenshotFlow.js / multiCheck.js:
 *   validateApiKey(key)
 *   keepOnlyFinalAnswer(rawAnswer, mode)
 *   sleep(ms)
 *   fetchWithTimeout(url, options, timeoutMs, signal)
 *   dataUrlToBlob(dataUrl)
 *   blobToDataUrl(blob)
 *   normalizeAssistantContent(content)
 *   fetchCompletion(requestType, mode, model, messages, signal, requestOptions)
 */

const ROUTERAI_BASE_URL = 'https://routerai.ru/api/v1';
const ROUTERAI_CHAT_COMPLETIONS_ENDPOINT = `${ROUTERAI_BASE_URL}/chat/completions`;

/* ─────────────────────── API key validation ─────────────────────── */

function validateApiKey(key) {
  const k = String(key || '').trim();
  if (!k) {
    return { valid: false, error: 'API key не найден. Укажите ключ RouterAI в настройках расширения.' };
  }

  // RouterAI documentation says to pass the key as `Authorization: Bearer YOUR_API_KEY`.
  // RouterAI does not require a provider-specific prefix, so we only
  // reject obviously invalid pasted values.
  if (/\s/.test(k) || k.length < 8) {
    return { valid: false, error: 'Неверный формат API key. Проверьте ключ RouterAI в настройках.' };
  }

  return { valid: true };
}

/* ─────────────────────── answer post-processing ─────────────────── */

function keepOnlyFinalAnswer(rawAnswer, mode) {
  const normalized = String(rawAnswer || '').trim();
  if (!normalized) return '';

  // Explain/chat modes must never be shortened.
  if (mode === 'explain') return normalized;

  // For quick-answer modes, formatting is controlled by prompts, not by destructive
  // post-processing. Do not take only the first line, do not extract only the first
  // letter/number, and do not rewrite model output. This keeps free-text answers intact
  // while still removing the most common harmless prefix.
  return stripFinalAnswerPrefix(normalized);
}

function stripFinalAnswerPrefix(answerText) {
  return String(answerText || '')
    .trim()
    .replace(/^\s*(final\s+answer|answer|ответ|итоговый\s+ответ)\s*[:\-–—]\s*/i, '')
    .trim();
}

/* ─────────────────────── reasoning model detection ──────────────── */

function isReasoningModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  return /\/gpt-5/.test(id) || /\/(o1|o3|o4)/.test(id);
}

/* ─────────────────────── network helpers ────────────────────────── */

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options, timeoutMs, signal) {
  const ctrl = new AbortController();
  const timerId = setTimeout(() => ctrl.abort(new Error('REQUEST_TIMEOUT')), timeoutMs);
  let onAbort = null;

  if (signal) {
    if (signal.aborted) {
      ctrl.abort(signal.reason);
    } else {
      onAbort = () => ctrl.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timerId);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function dataUrlToBlob(dataUrl) {
  const [meta, data = ''] = String(dataUrl || '').split(',', 2);
  const mime = meta.match(/^data:([^;]+)/i)?.[1] || 'application/octet-stream';
  const isB64 = /;base64$/i.test(meta);
  const str = isB64 ? atob(data) : decodeURIComponent(data);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
    r.readAsDataURL(blob);
  });
}

function normalizeAssistantContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text') return typeof p.text === 'string' ? p.text : '';
        if (p?.type === undefined && typeof p?.text === 'string') return p.text;
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

function extractAssistantText(data) {
  const choice = data?.choices?.[0];
  if (!choice) return '';

  const fromContent = normalizeAssistantContent(choice.message?.content);
  if (fromContent) return fromContent;

  const refusal = choice.message?.refusal;
  if (typeof refusal === 'string') {
    const r = refusal.trim();
    if (r && r.length <= 800) return r;
  }

  const fromText = normalizeAssistantContent(choice.text);
  if (fromText) return fromText;

  return '';
}

function getAllowedRouterAiPlugins(plugins) {
  const pdfOcr = Array.isArray(plugins) && plugins.length === 1
    && plugins[0]?.id === 'file-parser'
    && plugins[0]?.pdf?.engine === 'mistral-ocr';
  return pdfOcr ? [{ id:'file-parser', pdf:{ engine:'mistral-ocr' } }] : [];
}

async function attemptLengthRecovery(apiKey, model, messages, signal, requestOptions = {}) {
  try {
    const baseMax = Math.max(32, Number(requestOptions?.maxTokens) || 500);
    const recoveryMax = Math.min(baseMax + 700, 1200);
    const reqTemp = Number(requestOptions?.temperature);
    const body = {
      model,
      messages,
      temperature: Number.isFinite(reqTemp) ? Math.max(0, Math.min(2, reqTemp)) : 0,
      max_completion_tokens: recoveryMax,
    };
    if (isReasoningModel(model)) body.reasoning = { effort: 'low' };

    const response = await fetchWithTimeout(ROUTERAI_CHAT_COMPLETIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    }, Number(requestOptions?.timeoutMs) || API_TIMEOUT_MS, signal);

    if (!response.ok) return { answer: '' };

    const data = await response.json();
    const answer = keepOnlyFinalAnswer(extractAssistantText(data), 'answer');
    if (answer) globalThis.TALogger.logAction('Length recovery succeeded', { model });
    return { answer };
  } catch (e) {
    globalThis.TALogger.logError(new Error(`Recovery attempt failed: ${e.message}`), { model, recovery: true });
    return { answer: '' };
  }
}

/* ─────────────────────── core API call (RouterAI) ────────────────── */

async function fetchCompletion(requestType, mode, model, messages, signal, requestOptions = {}) {
  const apiKey = await getApiKey();
  const keyCheck = validateApiKey(apiKey);
  if (!keyCheck.valid) {
    const err = new Error(keyCheck.error);
    globalThis.TALogger.logError(err);
    throw err;
  }

  const userPart = messages?.find((m) => m?.role === 'user');
  const previewText = typeof userPart?.content === 'string'
    ? userPart.content
    : (Array.isArray(userPart?.content) ? userPart.content.map((p) => p?.text || '').join(' ') : '');

  if (requestType !== 'screenshot') {
    globalThis.TALogger.logRequest({ type: requestType, model, payloadPreview: previewText.slice(0, 300) });
  }

  let lastError = null;

  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(API_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * 400));

    try {
      const t0 = Date.now();
      const isScreenshot = requestType === 'screenshot';
      const reqTemperature = Number(requestOptions?.temperature);
      const body = {
        model,
        messages,
        temperature: Number.isFinite(reqTemperature) ? Math.max(0, Math.min(2, reqTemperature)) : 0,
      };
      const plugins = getAllowedRouterAiPlugins(requestOptions?.plugins);
      if (plugins.length) body.plugins = plugins;

      const maxTokens = Number(requestOptions?.maxTokens);
      if (Number.isFinite(maxTokens) && maxTokens > 0) {
        if (isScreenshot || isReasoningModel(model)) {
          body.max_completion_tokens = Math.floor(maxTokens);
        } else {
          body.max_tokens = Math.floor(maxTokens);
        }
      }
      if (isScreenshot && isReasoningModel(model)) {
        body.reasoning = { effort: 'low' };
      }

      const response = await fetchWithTimeout(ROUTERAI_CHAT_COMPLETIONS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      }, Number(requestOptions?.timeoutMs) || API_TIMEOUT_MS, signal);

      console.info(`[TA] ${Date.now() - t0}ms provider=RouterAI type=${requestType} mode=${mode} model=${model} attempt=${attempt + 1}`);

      if (!response.ok) {
        const errText = await response.text();
        const error = Object.assign(
          new Error(`RouterAI API ${response.status}: ${errText}`),
          { retriable: response.status === 429 || response.status >= 500 }
        );
        globalThis.TALogger.logError(error, { status: response.status, model });
        if (error.retriable && attempt < API_MAX_RETRIES) { lastError = error; continue; }
        throw error;
      }

      const data = await response.json();
      const choice = data?.choices?.[0];
      const rawContent = choice?.message?.content;
      const finishReason = String(choice?.finish_reason || '');
      const answer = keepOnlyFinalAnswer(extractAssistantText(data), mode);

      if (!answer) {
        globalThis.TALogger.logError(
          new Error(`Empty answer extracted — finish_reason=${finishReason || 'none'}, content=${JSON.stringify(rawContent)?.slice(0, 150) || 'null'}`),
          { model }
        );

        if (finishReason === 'content_filter') {
          throw new Error('RouterAI: провайдер заблокировал ответ (content filter).');
        }

        if (isScreenshot && finishReason === 'length') {
          const rec = await attemptLengthRecovery(apiKey, model, messages, signal, requestOptions);
          if (rec.answer) return rec.answer;
          throw Object.assign(
            new Error(`RouterAI: пустой ответ (finish_reason=length, recovery=true, model=${model})`),
            { noRetry: true }
          );
        }

        throw Object.assign(new Error('RouterAI вернул пустой ответ.'), { retriable: true });
      }

      return answer;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.noRetry) throw error;

      const isTimeout = String(error?.message || '').includes('REQUEST_TIMEOUT') || error?.name === 'AbortError';
      const retryable = isTimeout || error?.name === 'TypeError' || error?.retriable;

      if (retryable && attempt < API_MAX_RETRIES) {
        lastError = Object.assign(error instanceof Error ? error : new Error(String(error)), { retriable: true });
        continue;
      }

      if (isTimeout) {
        const effectiveTimeout = Number(requestOptions?.timeoutMs) || API_TIMEOUT_MS;
        const te = Object.assign(new Error(`Превышено время ожидания (${Math.round(effectiveTimeout / 1000)} сек).`), { retriable: true });
        globalThis.TALogger.logError(te, { model });
        throw te;
      }

      globalThis.TALogger.logError(error, { model });
      throw error;
    }
  }

  const err = lastError || new Error('Не удалось получить ответ от RouterAI API.');
  globalThis.TALogger.logError(err, { model });
  throw err;
}
