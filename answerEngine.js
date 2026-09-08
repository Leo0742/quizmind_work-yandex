/**
 * answerEngine.js — Text answer engine (service worker only)
 *
 * Quick-answer requests must be fresh. Quiz/test questions can look identical while
 * the selected option set, surrounding context, screenshot, or page state changed.
 * Therefore this file intentionally does not cache real AI answers.
 */

const CHAT_FILE_MIME_BY_EXTENSION = Object.freeze({
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
const CHAT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const CHAT_MAX_TOTAL_FILE_BYTES = 12 * 1024 * 1024;
const CHAT_MAX_FILE_DATA_URL_CHARS = Math.ceil(CHAT_MAX_FILE_BYTES * 4 / 3) + 512;

function detectLanguage(text) {
  if (!text) return 'en';
  const letters = text.replace(/\s/g, '');
  if (!letters.length) return 'en';
  const cyrillic = (letters.match(/[а-яёА-ЯЁ]/g) || []).length;
  return (cyrillic / letters.length) > 0.25 ? 'ru' : 'en';
}

function langInstruction(lang) {
  return lang === 'ru' ? 'Отвечай на русском языке. ' : '';
}

async function buildSystemPrompt(mode, lang) {
  const langNote = langInstruction(lang);
  const { getPrompt } = globalThis.TAPromptsConfig;

  if (mode === 'explain') {
    const promptId = lang === 'ru' ? 'explain_system_ru' : 'explain_system_en';
    const base = await getPrompt(promptId);
    return lang === 'ru' ? `${langNote}${base}` : base;
  }

  if (mode === 'yandex_question') {
    return getPrompt('yandex_question_answer_system_v1');
  }

  const base = await getPrompt('quiz_answer_system_v2');
  return `${langNote}${base}`;
}

async function fetchTextAnswerWithModel(questionText, modelId) {
  const settings = await getSettings();
  const lang = detectLanguage(questionText);
  const systemPrompt = await buildSystemPrompt('answer', lang);
  const userPrefix = await globalThis.TAPromptsConfig.getPrompt('quiz_answer_user_prefix_v2');
  const userContent = `${userPrefix}\n${questionText}`;
  const effectiveModel = String(modelId || '').trim();

  if (!effectiveModel) throw new Error('Модель не выбрана.');

  if (settings.test_mode) {
    const MOCKS = ['a', 'b', 'c', 'd', 'a, c'];
    await new Promise(r => setTimeout(r, 300 + Math.random() * 700));
    return MOCKS[Math.floor(Math.random() * MOCKS.length)];
  }

  return fetchCompletion('text', 'answer', effectiveModel, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ]);
}

function sanitizeChatFilePart(part, fileBudget) {
  if (part?.type !== 'file' || !part.file || typeof part.file !== 'object') return null;
  const filename = String(part.file.filename || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
  const extension = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] || '';
  const expectedMime = CHAT_FILE_MIME_BY_EXTENSION[extension];
  const fileData = String(part.file.file_data || '');
  const match = fileData.match(/^data:([^;,]+);base64,/i);
  if (!filename || !expectedMime || String(match?.[1] || '').toLowerCase() !== expectedMime || fileData.length > CHAT_MAX_FILE_DATA_URL_CHARS) return null;
  const payload = fileData.slice(fileData.indexOf(',') + 1).replace(/=+$/, '');
  const bytes = Math.floor(payload.length * 0.75);
  if (bytes < 1 || bytes > CHAT_MAX_FILE_BYTES || fileBudget.bytes + bytes > CHAT_MAX_TOTAL_FILE_BYTES) return null;
  fileBudget.bytes += bytes;
  return { type:'file', file:{ filename, file_data:fileData } };
}

function sanitizeChatCompletionMessage(message, fileBudget = { bytes:0 }) {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return null;
  if (typeof message.content === 'string' || typeof message.text === 'string') {
    const content = String(message.content ?? message.text ?? '').trim().slice(0, 20_000);
    return content ? { role: message.role, content } : null;
  }
  if (message.role !== 'user' || !Array.isArray(message.content)) return null;

  const content = [];
  let imageCount = 0;
  let fileCount = 0;
  let textChars = 0;
  for (const part of message.content) {
    if (part?.type === 'text' && typeof part.text === 'string' && textChars < 20_000) {
      const text = part.text.trim().slice(0, 20_000 - textChars);
      if (text) { content.push({ type:'text', text }); textChars += text.length; }
      continue;
    }
    const dataUrl = String(part?.image_url?.url || '');
    if (part?.type === 'image_url' && imageCount < 4 && /^data:image\/(png|jpe?g|webp);base64,/i.test(dataUrl) && dataUrl.length <= 1_400_000) {
      content.push({ type:'image_url', image_url:{ url:dataUrl } });
      imageCount += 1;
      continue;
    }
    if (part?.type === 'file') {
      if (fileCount >= 3) throw new Error('Invalid chat file attachment.');
      const filePart = sanitizeChatFilePart(part, fileBudget);
      if (!filePart) throw new Error('Invalid chat file attachment.');
      content.push(filePart);
      fileCount += 1;
    }
  }
  return content.length ? { role: message.role, content } : null;
}

function getChatPdfOcrPlugins(messages, plugins) {
  const requested = Array.isArray(plugins) && plugins.length === 1
    && plugins[0]?.id === 'file-parser'
    && plugins[0]?.pdf?.engine === 'mistral-ocr';
  if (!requested) return null;
  const hasPdf = messages.some(message => Array.isArray(message?.content) && message.content.some(part => (
    part?.type === 'file'
    && String(part.file?.filename || '').toLowerCase().endsWith('.pdf')
    && /^data:application\/pdf;base64,/i.test(String(part.file?.file_data || '').slice(0, 64))
  )));
  return hasPdf ? [{ id:'file-parser', pdf:{ engine:'mistral-ocr' } }] : null;
}

async function fetchChatCompletion(modelId, messages = [], options = {}) {
  const fileBudget = { bytes:0 };
  const sourceMessages = Array.isArray(messages) ? messages.slice(-20) : [];
  const normalizedByIndex = new Array(sourceMessages.length);
  for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
    normalizedByIndex[index] = sanitizeChatCompletionMessage(sourceMessages[index], fileBudget);
  }
  const normalized = normalizedByIndex.filter(Boolean);

  if (!normalized.length) throw new Error('Пустая история сообщений.');
  const effectiveModel = String(modelId || '').trim();
  if (!effectiveModel) throw new Error('Модель не выбрана.');
  const chatSystem = await globalThis.TAPromptsConfig.getPrompt('chat_system');
  const timeoutMs = Number(options?.timeoutMs);
  const maxTokens = Number(options?.maxTokens);
  const plugins = getChatPdfOcrPlugins(normalized, options?.plugins);
  return fetchCompletion('text', 'explain', effectiveModel, [
    { role: 'system', content: chatSystem },
    ...normalized,
  ], options?.signal, {
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs:Math.floor(timeoutMs) } : {}),
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens:Math.floor(maxTokens) } : {}),
    ...(plugins ? { plugins } : {}),
  });
}

async function fetchTextAnswer(questionText, mode = 'answer') {
  const settings = await getSettings();
  if (settings.test_mode) {
    const mock = mode === 'explain'
      ? 'Тест-режим включён — реальный запрос не отправлялся.'
      : 'B';
    globalThis.TALogger.logAction('TEST MODE — mock answer', { mode, mock });
    return mode === 'explain'
      ? `${mock}\n---\n🧪 **Тест-режим:** реальный запрос к API не отправлялся. Это мок-ответ для экономии токенов.`
      : mock;
  }

  const lang = detectLanguage(questionText);
  const { textModel } = await getModels();
  const effectiveModel = String(textModel || '').trim();
  if (!effectiveModel) throw new Error('Модель для текста не выбрана.');

  const systemPrompt = await buildSystemPrompt(mode, lang);
  let userContent;
  if (mode === 'explain') {
    userContent = `Question:\n${questionText}`;
  } else if (mode === 'yandex_question') {
    const prefix = await globalThis.TAPromptsConfig.getPrompt('yandex_question_answer_user_prefix_v1');
    userContent = `${prefix}\n${questionText}`;
  } else {
    const prefix = await globalThis.TAPromptsConfig.getPrompt('quiz_answer_user_prefix_v2');
    userContent = `${prefix}\n${questionText}`;
  }

  globalThis.TALogger.logAction('Fresh answer request', { mode, model: effectiveModel });

  return fetchCompletion('text', mode, effectiveModel, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ]);
}
