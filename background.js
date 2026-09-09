importScripts('settingsStorage.js');
importScripts('modelsService.js');
importScripts('logger.js');
importScripts('promptsConfig.js');
importScripts('apiCore.js');
importScripts('answerEngine.js');
importScripts('screenshotFlow.js');
importScripts('multiCheck.js');

const ROUTERAI_BILLING_HINT = 'RouterAI Billing';
const API_TIMEOUT_MS = 25_000;
const API_MAX_RETRIES = 1;
const API_RETRY_BASE_DELAY_MS = 800;
const IMAGE_OPT_PRIMARY = { maxSide: 1280, mimeType: 'image/jpeg', quality: 0.78 };
const IMAGE_OPT_FALLBACK = { maxSide: 960, mimeType: 'image/jpeg', quality: 0.62 };
const SCREENSHOT_MAX_TOKENS = 500;
const SCREENSHOT_TIMEOUT_LIGHT_MS = 35_000;
const SCREENSHOT_TIMEOUT_DEFAULT_MS = 55_000;
const SCREENSHOT_TIMEOUT_HEAVY_MS = 110_000;
const CHAT_IMAGE_TIMEOUT_MS = 110_000;
const CHAT_FILE_TIMEOUT_MS = 180_000;
const CHAT_PDF_OCR_TIMEOUT_MS = 240_000;
const CHAT_MAX_TOKENS = 1200;
const CHAT_PDF_OCR_PLUGINS = Object.freeze([
  Object.freeze({ id:'file-parser', pdf:Object.freeze({ engine:'mistral-ocr' }) }),
]);
globalThis.__QM_TEST_STATS = { getAnswer:0, selection:0, screenshot:0, yandex:0, visualCapture:0, visualAnswer:0 };
function bumpTestStat(name) {
  if (Object.hasOwn(globalThis.__QM_TEST_STATS, name)) globalThis.__QM_TEST_STATS[name] += 1;
}

function isChatPdfFilePart(part) {
  if (part?.type !== 'file') return false;
  const filename = String(part.file?.filename || '').toLowerCase();
  const fileDataPrefix = String(part.file?.file_data || '').slice(0, 64);
  return filename.endsWith('.pdf') && /^data:application\/pdf;base64,/i.test(fileDataPrefix);
}

function requestsChatPdfOcr(plugins) {
  return Array.isArray(plugins) && plugins.length === 1
    && plugins[0]?.id === 'file-parser'
    && plugins[0]?.pdf?.engine === 'mistral-ocr';
}

async function syncLogger() {
  try {
    const s = await globalThis.TASettingsStorage.getSettings();
    await globalThis.TALogger.initLogger(s);
  } catch (e) {
    console.warn('[TA] syncLogger:', e);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.taSettings) syncLogger();
});

async function getSettings() { return globalThis.TASettingsStorage.getSettings(); }

async function fetchYandexVisionAnswer({ imageDataUrls, questionText, questionType }) {
  const settings = await getSettings();
  const { visionModel } = await getModels();
  if (settings.test_mode) return { answer: 'B', model: visionModel };

  const { getPrompt } = globalThis.TAPromptsConfig;
  const systemPrompt = await getPrompt('yandex_screenshot_answer_system_v1');
  const userPrefix = await getPrompt('yandex_screenshot_answer_user_v1');
  const textPrompt = `${userPrefix}\n\nQUESTION_TYPE:\n${questionType || 'unsupported'}\n\n${questionText}`;
  const profile = getScreenshotRequestProfile(visionModel, true, settings);
  const answer = await fetchVisionAnswer({
    imageDataUrls,
    textPrompt,
    systemPrompt,
    model: visionModel,
    profile,
    mode:'yandex_screenshot',
  });
  return { answer, model: visionModel };
}

async function getModels() {
  const s = await getSettings();
  let textModel = String(s.model_text || '').trim();
  let visionModel = String(s.model_vision || '').trim();
  if (textModel && visionModel) return { textModel, visionModel };
  const [chatCatalog, imageCatalog] = await Promise.all([
    globalThis.TAModelsService.getModels({ type: 'chat' }),
    globalThis.TAModelsService.getModels({ type: 'image' }),
  ]);
  const chatModels = Array.isArray(chatCatalog.models) ? chatCatalog.models : [];
  const imageModels = Array.isArray(imageCatalog.models) ? imageCatalog.models : [];
  if (!textModel) textModel = chatModels[0]?.id || '';
  if (!visionModel) visionModel = imageModels[0]?.id || textModel;
  if (!textModel) throw new Error('Text model is not selected.');
  if (!visionModel) throw new Error('Screenshot model is not selected.');
  const patch = {};
  if (!String(s.model_text || '').trim()) patch.model_text = textModel;
  if (!String(s.model_vision || '').trim()) patch.model_vision = visionModel;
  if (Object.keys(patch).length) await globalThis.TASettingsStorage.setSettings(patch);
  return { textModel, visionModel };
}

async function getApiKey() {
  const d = await chrome.storage.local.get(['routeraiApiKey']);
  return d.routeraiApiKey || null;
}

async function isExtensionEnabled() {
  const d = await chrome.storage.local.get(['extension_enabled']);
  return d.extension_enabled !== false;
}

async function setExtensionEnabled(value) { await chrome.storage.local.set({ extension_enabled: Boolean(value) }); }

async function broadcastExtensionEnabledChanged() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.filter((t) => t.id).map((t) => chrome.tabs.sendMessage(t.id, { type: 'EXTENSION_ENABLED_CHANGED' }).catch(() => {})));
  } catch {}
}

async function toggleExtensionEnabled({ byHotkey = false } = {}) {
  const current = await isExtensionEnabled();
  const next = !current;
  await setExtensionEnabled(next);
  if (byHotkey) globalThis.TALogger.logAction('Hotkey extension toggle state changed', { enabled: next });
  await broadcastExtensionEnabledChanged();
  return next;
}

async function fetchBalanceAmount() {
  const apiKey = await getApiKey();
  const keyCheck = validateApiKey(apiKey);
  if (!keyCheck.valid) return { ok: false, noApiKey: !apiKey, error: keyCheck.error };
  return { ok: true, unsupported: true, amount: ROUTERAI_BILLING_HINT };
}

const injectedTabs = new Set();
chrome.tabs.onRemoved.addListener((tabId) => injectedTabs.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => { if (changeInfo.status === 'loading') injectedTabs.delete(tabId); });

function canInjectIntoUrl(url) { return /^https?:\/\//i.test(String(url || '')); }

async function ensureContentInjected(tabId) {
  if (injectedTabs.has(tabId)) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['i18n.js', 'routeraiUiPatch.js', 'settingsStorage.js', 'themeEngine.js', 'content/qm-shared.js', 'content/qm-windows.js', 'content/qm-hotkeys.js', 'content/qm-yandex-forms.js', 'content/qm-quiz.js', 'content/qm-markdown.js', 'content/qm-logger.js', 'content.js'],
  });
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['styles.css'] });
  injectedTabs.add(tabId);
}

async function ensureTabReadyForSelection(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.id || !canInjectIntoUrl(tab.url)) return;
    await ensureContentInjected(tab.id);
  } catch (e) {
    console.info('[TA] ensureTabReadyForSelection skipped:', e?.message || e);
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => tabId && ensureTabReadyForSelection(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && canInjectIntoUrl(tab?.url)) ensureContentInjected(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'EXTENSION_ENABLED_CHANGED') {
    (async () => {
      try { await broadcastExtensionEnabledChanged(); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: e?.message || 'Tabs update failed.' }); }
    })();
    return true;
  }

  if (message?.type === 'TOGGLE_EXTENSION_HOTKEY') {
    (async () => {
      try { sendResponse({ ok: true, enabled: await toggleExtensionEnabled({ byHotkey: true }) }); }
      catch (e) { sendResponse({ ok: false, error: e?.message || 'Toggle failed.' }); }
    })();
    return true;
  }

  if (message?.type === 'GET_ANSWER') {
    (async () => {
      try {
        if (!(await isExtensionEnabled())) { sendResponse({ ok: false, error: 'Extension is disabled.', disabled: true }); return; }
        const questionText = String(message.payload?.questionText || '').trim();
        const requestedMode = message.payload?.mode;
        const mode = ['explain', 'yandex_question'].includes(requestedMode) ? requestedMode : 'answer';
        if (!questionText) throw new Error('Empty question.');
        bumpTestStat('getAnswer');
        if (message.payload?.source === 'button') bumpTestStat('selection');
        if (mode === 'yandex_question') bumpTestStat('yandex');
        const answer = await fetchTextAnswer(questionText, mode);
        const { textModel } = await getModels();
        sendResponse({ ok: true, answer, mode, model: textModel });
      } catch (e) {
        globalThis.TALogger.logError(e, { source: 'GET_ANSWER' });
        sendResponse({ ok: false, error: e.message || 'Unknown error' });
      }
    })();
    return true;
  }

  if (message?.type === 'CAPTURE_YANDEX_QUESTION') {
    (async () => {
      try {
        if (!(await isExtensionEnabled())) { sendResponse({ ok: false, error: 'Extension is disabled.', disabled: true }); return; }
        const tab = sender.tab;
        if (!/^https:\/\/forms\.yandex\.ru\//i.test(String(tab?.url || ''))) throw new Error('Capture is restricted to Yandex Forms.');
        const rect = message.payload?.rect || {};
        const viewport = message.payload?.viewport || {};
        if (!tab?.id || !Number.isInteger(tab.windowId)) throw new Error('Yandex Forms question tab is unavailable.');
        if (![rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(Number(value))) || Number(rect.width) < 2 || Number(rect.height) < 2) {
          throw new Error('Invalid Yandex Forms question bounds.');
        }
        bumpTestStat('visualCapture');

        const settings = await getSettings();
        const { visionModel } = await getModels();
        const profile = getScreenshotRequestProfile(visionModel, true, settings);
        const captureDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const bitmap = await createImageBitmap(dataUrlToBlob(captureDataUrl));
        const captureSize = { width: bitmap.width, height: bitmap.height };
        bitmap.close?.();
        const mappedRect = mapRoiToCapturePixels(rect, viewport, captureSize.width, captureSize.height);
        const dataUrl = await cropScreenshotToRoi(captureDataUrl, mappedRect, profile.primaryOpt);
        sendResponse({ ok: true, dataUrl });
      } catch (e) {
        globalThis.TALogger.logError(e, { source: 'CAPTURE_YANDEX_QUESTION' });
        sendResponse({ ok: false, error: e.message || 'Yandex Forms screenshot capture failed.' });
      }
    })();
    return true;
  }

  if (message?.type === 'GET_YANDEX_SCREENSHOT_ANSWER') {
    (async () => {
      try {
        if (!(await isExtensionEnabled())) { sendResponse({ ok: false, error: 'Extension is disabled.', disabled: true }); return; }
        if (!/^https:\/\/forms\.yandex\.ru\//i.test(String(sender.tab?.url || ''))) throw new Error('Visual answers are restricted to Yandex Forms.');
        const questionText = String(message.payload?.questionText || '').trim();
        const questionType = String(message.payload?.questionType || 'unsupported').trim();
        const dataUrl = String(message.payload?.dataUrl || '');
        if (!questionText) throw new Error('Empty Yandex Forms question.');
        if (!/^data:image\//i.test(dataUrl)) throw new Error('Invalid Yandex Forms question screenshot.');
        bumpTestStat('visualAnswer');
        const result = await fetchYandexVisionAnswer({
          imageDataUrls: [dataUrl],
          questionText,
          questionType,
        });
        sendResponse({ ok: true, answer: result.answer, mode: 'yandex_screenshot', model: result.model });
      } catch (e) {
        globalThis.TALogger.logError(e, { source: 'GET_YANDEX_SCREENSHOT_ANSWER' });
        sendResponse({ ok: false, error: e.message || 'Yandex Forms screenshot answer failed.' });
      }
    })();
    return true;
  }

  if (message?.type === 'GET_MULTI_CONSENSUS') {
    (async () => {
      try {
        if (!(await isExtensionEnabled())) { sendResponse({ ok: false, error: 'Extension is disabled.', disabled: true }); return; }
        const questionText = String(message.payload?.questionText || '').trim();
        const models = Array.isArray(message.payload?.models) ? message.payload.models : [];
        if (!questionText) throw new Error('Empty question.');
        if (!models.length) throw new Error('No models selected for multi-check.');
        const primaryAnswer = String(message.payload?.primaryAnswer || '').trim();
        const consensusResult = await runTextConsensusCheck({ questionText, models, primaryAnswer });
        sendResponse({ ok: true, ...consensusResult });
      } catch (e) {
        globalThis.TALogger.logError(e, { source: 'GET_MULTI_CONSENSUS' });
        sendResponse({ ok: false, error: e.message || 'Unknown error' });
      }
    })();
    return true;
  }

  if (message?.type === 'GET_TEXT_VERDICT') {
    const { originalAnswer, consensus, judgeConfidence, judgeVerdict } = message.payload || {};
    sendResponse({ ok: true, verdict: computeTextVerdict({ originalAnswer, consensus, judgeConfidence, judgeVerdict }) });
    return true;
  }

  if (message?.type === 'LOG_ACTION') {
    globalThis.TALogger.logAction(message.payload?.message || 'Unknown', message.payload?.meta);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === 'DOWNLOAD_QM_LOGS') {
    (async () => {
      try {
        const { text, filename, saveAs } = message.payload || {};
        if (!text || !filename) { sendResponse({ ok: false, error: 'Missing content or filename.' }); return; }
        const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
        await new Promise((resolve, reject) => chrome.downloads.download({ url: dataUrl, filename, saveAs: Boolean(saveAs), conflictAction: 'uniquify' }, (id) => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(id)));
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: e?.message || 'Download failed.' }); }
    })();
    return true;
  }

  if (message?.type === 'GET_CHAT_MODELS' || message?.type === 'GET_IMAGE_MODELS') {
    (async () => {
      try {
        if (!(await isExtensionEnabled())) { sendResponse({ ok: false, error: 'Extension is disabled.', disabled: true }); return; }
        const type = message.type === 'GET_IMAGE_MODELS' ? 'image' : 'chat';
        const result = await globalThis.TAModelsService.getModels({ type, forceRefresh: Boolean(message?.forceRefresh) });
        const models = (result.models || []).map((m) => ({
          id: m.id,
          name: m.name || m.id,
          short_description: m.short_description || '',
          architecture: m.architecture && typeof m.architecture === 'object' ? m.architecture : {},
        }));
        if (type === 'image') { sendResponse({ ok: true, models, error: result.error || null }); return; }
        const favorites = await globalThis.TAModelsService.getFavoriteModels();
        const favSet = new Set((favorites || []).map(String));
        sendResponse({ ok: true, favorites: models.filter((m) => favSet.has(m.id)), models, error: result.error || null });
      } catch (e) { sendResponse({ ok: false, error: e?.message || 'Models load failed.' }); }
    })();
    return true;
  }

  if (message?.type === 'CHAT_COMPLETE') {
    (async () => {
      let timeoutId = null;
      let controller = null;
      let hasFiles = false;
      let usePdfOcr = false;
      try {
        if (!(await isExtensionEnabled())) { sendResponse({ ok: false, error: 'Extension is disabled.', disabled: true }); return; }
        const model = String(message.payload?.model || '').trim();
        if (!model) throw new Error('Model is not selected.');
        const messages = Array.isArray(message.payload?.messages) ? message.payload.messages : [];
        const hasImages = messages.some(item => Array.isArray(item?.content) && item.content.some(part => part?.type === 'image_url'));
        hasFiles = messages.some(item => Array.isArray(item?.content) && item.content.some(part => part?.type === 'file'));
        const hasPdf = messages.some(item => Array.isArray(item?.content) && item.content.some(isChatPdfFilePart));
        usePdfOcr = hasPdf && requestsChatPdfOcr(message.payload?.plugins);
        if (hasFiles || hasImages) {
          controller = new AbortController();
          const timeoutCode = usePdfOcr ? 'CHAT_PDF_OCR_TIMEOUT' : (hasFiles ? 'CHAT_FILE_TIMEOUT' : 'CHAT_IMAGE_TIMEOUT');
          const timeoutMs = usePdfOcr ? CHAT_PDF_OCR_TIMEOUT_MS : (hasFiles ? CHAT_FILE_TIMEOUT_MS : CHAT_IMAGE_TIMEOUT_MS);
          timeoutId = setTimeout(() => controller.abort(new Error(timeoutCode)), timeoutMs);
        }
        const answer = await fetchChatCompletion(model, messages, {
          signal: controller?.signal,
          timeoutMs: usePdfOcr ? CHAT_PDF_OCR_TIMEOUT_MS + 1_000 : (hasFiles ? CHAT_FILE_TIMEOUT_MS + 1_000 : (hasImages ? CHAT_IMAGE_TIMEOUT_MS + 1_000 : undefined)),
          maxTokens: CHAT_MAX_TOKENS,
          ...(usePdfOcr ? { plugins:CHAT_PDF_OCR_PLUGINS } : {}),
        });
        sendResponse({ ok: true, answer, model });
      } catch (e) {
        const abortReason = controller?.signal?.aborted ? String(controller.signal.reason?.message || '') : '';
        const fileRejected = hasFiles && /RouterAI API (400|415|422):/i.test(String(e?.message || ''));
        const fileInvalid = hasFiles && String(e?.message || '') === 'Invalid chat file attachment.';
        if (abortReason === 'CHAT_PDF_OCR_TIMEOUT') sendResponse({ ok:false, errorCode:'CHAT_PDF_OCR_TIMEOUT', error:'Chat PDF OCR request timed out.' });
        else if (abortReason === 'CHAT_FILE_TIMEOUT') sendResponse({ ok:false, errorCode:'CHAT_FILE_TIMEOUT', error:'Chat file request timed out.' });
        else if (abortReason === 'CHAT_IMAGE_TIMEOUT') sendResponse({ ok:false, errorCode:'CHAT_IMAGE_TIMEOUT', error:'Chat image request timed out.' });
        else if (fileInvalid) sendResponse({ ok:false, errorCode:'CHAT_FILE_INVALID', error:'Invalid chat file attachment.' });
        else if (fileRejected) sendResponse({ ok:false, errorCode:'CHAT_FILE_REJECTED', error:'RouterAI rejected the attached file.' });
        else sendResponse({ ok:false, error:e?.message || 'Chat failed.' });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    })();
    return true;
  }

  if (message?.type === 'GET_ROUTERAI_BALANCE') {
    (async () => {
      try { sendResponse(await fetchBalanceAmount()); }
      catch { sendResponse({ ok: true, unsupported: true, amount: ROUTERAI_BILLING_HINT }); }
    })();
    return true;
  }

  if (message?.type === 'TRIGGER_SCREENSHOT_FROM_CONTENT') {
    (async () => {
      try {
        if (!(await isExtensionEnabled())) { sendResponse({ ok: false, error: 'Extension is disabled.', disabled: true }); return; }
        const tab = sender?.tab || await getActiveTab();
        if (!tab || !canInjectIntoUrl(tab.url)) { sendResponse({ ok: false, error:'Screenshots are available only on ordinary web pages.' }); return; }
        bumpTestStat('screenshot');
        await handleScreenshotFlow(tab);
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  return false;
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === 'toggle-extension-enabled') {
      const enabled = await toggleExtensionEnabled({ byHotkey: true });
      globalThis.TALogger.logAction('Hotkey extension toggle pressed', { enabled });
      return;
    }
    if (command === 'yandex-question') {
      if (!(await isExtensionEnabled())) return;
      const tab = await getActiveTab();
      if (!tab?.id || !String(tab.url || '').startsWith('https://forms.yandex.ru/')) return;
      globalThis.TALogger.logAction('Yandex question hotkey pressed');
      await chrome.tabs.sendMessage(tab.id, { type:'TRIGGER_YANDEX_QUESTION' });
      return;
    }
    if (command !== 'screenshot-answer') return;
    if (!(await isExtensionEnabled())) return;
    const tab = await getActiveTab();
    if (!tab?.id || !canInjectIntoUrl(tab.url)) return;
    globalThis.TALogger.logAction('Hotkey screenshot pressed');
    bumpTestStat('screenshot');
    await handleScreenshotFlow(tab);
  } catch (e) { globalThis.TALogger.logError(e, { source: 'onCommand', command }); }
});

chrome.runtime.onStartup.addListener(syncLogger);
chrome.runtime.onInstalled.addListener(syncLogger);
chrome.runtime.onSuspend.addListener(() => {
  globalThis.TALogger.logAction('SW suspending — flushing logs');
  globalThis.TALogger.flushToFile();
});

(async () => {
  try {
    const tab = await getActiveTab();
    if (tab?.id) await ensureTabReadyForSelection(tab.id);
  } catch {}
})();

syncLogger();

globalThis.TALogger.setLiveCallback(null);
