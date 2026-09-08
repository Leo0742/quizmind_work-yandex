/**
 * screenshotFlow.js — Screenshot pipeline (service worker only)
 *
 * Loaded via importScripts() in background.js (before multiCheck.js).
 * Shares the service-worker global scope with background.js and multiCheck.js.
 *
 * Public API:
 *   fetchVisionAnswer({ imageDataUrls, textPrompt, systemPrompt, model, signal, profile, mode })
 *   handleScreenshotFlow(tab)
 */

function getVisionModelTier(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return 'default';
  if (/(gpt-5|gpt-4\.1|claude|sonnet|opus|gemini-.*pro|qwen3-max|grok-4|o1|o3|r1)/.test(id)) return 'heavy';
  if (/(flash|lite|mini|nano|haiku)/.test(id)) return 'light';
  return 'default';
}

function normalizeScreenshotParams(settings = {}) {
  const tempRaw = Number(settings?.screenshot_temperature);
  const tokensRaw = Number(settings?.screenshot_max_tokens);
  const screenshotTemperature = Number.isFinite(tempRaw) ? Math.max(0, Math.min(1, tempRaw)) : 0;
  const screenshotMaxTokens = Number.isFinite(tokensRaw) ? Math.max(32, Math.min(2048, Math.floor(tokensRaw))) : SCREENSHOT_MAX_TOKENS;
  return { screenshotTemperature, screenshotMaxTokens };
}

function getScreenshotRequestProfile(modelId, hasRoi, settings = {}) {
  const { screenshotTemperature, screenshotMaxTokens } = normalizeScreenshotParams(settings);
  const tier = getVisionModelTier(modelId);
  if (tier === 'heavy') {
    return {
      timeoutMs: SCREENSHOT_TIMEOUT_HEAVY_MS,
      primaryOpt: hasRoi
        ? { maxSide: 1400, mimeType: 'image/jpeg', quality: 0.82 }
        : { maxSide: 1200, mimeType: 'image/jpeg', quality: 0.78 },
      fallbackOpt: { maxSide: 1024, mimeType: 'image/jpeg', quality: 0.72 },
      maxTokens: screenshotMaxTokens,
      temperature: screenshotTemperature,
    };
  }
  if (tier === 'light') {
    return {
      timeoutMs: SCREENSHOT_TIMEOUT_LIGHT_MS,
      primaryOpt: hasRoi
        ? { maxSide: 1280, mimeType: 'image/jpeg', quality: 0.78 }
        : { maxSide: 1150, mimeType: 'image/jpeg', quality: 0.74 },
      fallbackOpt: { ...IMAGE_OPT_FALLBACK },
      maxTokens: screenshotMaxTokens,
      temperature: screenshotTemperature,
    };
  }
  return {
    timeoutMs: SCREENSHOT_TIMEOUT_DEFAULT_MS,
    primaryOpt: hasRoi
      ? { maxSide: 1280, mimeType: 'image/jpeg', quality: 0.8 }
      : { maxSide: 1150, mimeType: 'image/jpeg', quality: 0.76 },
    fallbackOpt: { maxSide: 960, mimeType: 'image/jpeg', quality: 0.66 },
    maxTokens: screenshotMaxTokens,
    temperature: screenshotTemperature,
  };
}

async function fetchVisionAnswer({ imageDataUrls, textPrompt, systemPrompt, model, signal, profile, mode = 'answer' }) {
  const images = (Array.isArray(imageDataUrls) ? imageDataUrls : []).map((dataUrl) => String(dataUrl || ''));
  if (!images.length || images.some((dataUrl) => !/^data:image\//i.test(dataUrl))) throw new Error('No valid images provided.');
  if (!String(model || '').trim()) throw new Error('Vision model is not selected.');

  return fetchCompletion('screenshot', mode, model, [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: textPrompt },
        ...images.map((dataUrl) => ({ type: 'image_url', image_url: { url: dataUrl } })),
      ]
    }
  ], signal, { timeoutMs: profile?.timeoutMs, maxTokens: profile?.maxTokens, temperature: profile?.temperature });
}

async function fetchScreenshotAnswer(dataUrl, signal, profile, visionModelOverride = '') {
  const { visionModel: resolvedVisionModel } = await getModels();
  const visionModel = visionModelOverride || resolvedVisionModel;
  const { getPrompt } = globalThis.TAPromptsConfig;
  const systemPrompt = await getPrompt('screenshot_answer_system_v2');
  const userText = await getPrompt('screenshot_answer_user_v2');
  return fetchVisionAnswer({
    imageDataUrls: [dataUrl],
    textPrompt: userText,
    systemPrompt,
    model: visionModel,
    signal,
    profile,
  });
}

async function cropScreenshotToRoi(dataUrl, roi, opt = IMAGE_OPT_PRIMARY) {
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  const x = roi ? Math.max(0, Math.floor(roi.x)) : 0;
  const y = roi ? Math.max(0, Math.floor(roi.y)) : 0;
  const srcW = roi ? Math.max(1, Math.min(Math.floor(roi.width), bitmap.width - x)) : bitmap.width;
  const srcH = roi ? Math.max(1, Math.min(Math.floor(roi.height), bitmap.height - y)) : bitmap.height;
  if (srcW <= 1 || srcH <= 1) return dataUrl;

  const scale = Math.min(1, Math.max(64, opt.maxSide || 1280) / Math.max(srcW, srcH));
  const tw = Math.max(1, Math.floor(srcW * scale));
  const th = Math.max(1, Math.floor(srcH * scale));
  const canvas = new OffscreenCanvas(tw, th);
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;

  ctx.drawImage(bitmap, x, y, srcW, srcH, 0, 0, tw, th);
  const quality = Math.max(0.4, Math.min(0.95, Number(opt.quality || 0.78)));
  const blob = await canvas.convertToBlob({ type: opt.mimeType || 'image/jpeg', quality });
  return blobToDataUrl(blob);
}

async function sendToTab(tabId, payload) {
  await ensureContentInjected(tabId);
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [50, 150, 300];
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (err) {
      const msg = String(err?.message || '');
      const isConnErr = msg.includes('Could not establish connection') || msg.includes('Receiving end does not exist');
      if (!isConnErr || attempt === MAX_RETRIES - 1) throw err;
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
}

async function requestManualRoi(tabId) {
  try {
    const r = await sendToTab(tabId, { type: 'REQUEST_SCREENSHOT_SELECTION' });
    return (r?.ok && r?.roi)
      ? { roi: r.roi, viewport: r.viewport || null, questionText: String(r.questionText || '').trim() }
      : null;
  } catch {
    return null;
  }
}

async function showScreenshotAnswerLoader(tabId) {
  try {
    await sendToTab(tabId, { type: 'SCREENSHOT_ANSWER_LOADING' });
  } catch (e) {
    globalThis.TALogger.logError(e, { source: 'showScreenshotAnswerLoader' });
  }
}

function mapRoiToCapturePixels(roi, viewport, cw, ch) {
  const vw = Math.max(1, Number(viewport?.visualViewportWidth || viewport?.innerWidth || 1));
  const vh = Math.max(1, Number(viewport?.visualViewportHeight || viewport?.innerHeight || 1));
  const ol = Number(viewport?.visualViewportOffsetLeft || 0);
  const ot = Number(viewport?.visualViewportOffsetTop || 0);
  return {
    x: Math.floor((Math.max(0, Number(roi?.x || 0)) + ol) * (cw / vw)),
    y: Math.floor((Math.max(0, Number(roi?.y || 0)) + ot) * (ch / vh)),
    width: Math.max(1, Math.floor(Math.max(1, Number(roi?.width || 1)) * (cw / vw))),
    height: Math.max(1, Math.floor(Math.max(1, Number(roi?.height || 1)) * (ch / vh)))
  };
}

let keepalivePort = null;
function keepaliveStart() {
  try {
    keepalivePort = chrome.runtime.connect({ name: 'keepalive' });
    keepalivePort.onDisconnect.addListener(() => { keepalivePort = null; });
  } catch {}
}
function keepaliveStop() {
  try { keepalivePort?.disconnect(); } catch {}
  keepalivePort = null;
}

let activeController = null;

async function handleScreenshotFlow(tab) {
  if (!tab?.id || !tab.windowId) return;
  if (activeController) activeController.abort(new Error('REPLACED'));

  const ctrl = new AbortController();
  activeController = ctrl;
  keepaliveStart();

  try {
    globalThis.TALogger.logAction('Screenshot flow started', { tabId: tab.id });
    const settings = await getSettings();
    let roiRes;

    if (settings.auto_send_screenshot) {
      globalThis.TALogger.logAction('Auto screenshot mode — capturing full viewport');
      roiRes = null;
    } else {
      roiRes = await requestManualRoi(tab.id);
      if (!roiRes?.roi) {
        globalThis.TALogger.logAction('Screenshot selection canceled');
        return;
      }
    }

    // Show the same answer loader used by text requests as soon as the screenshot
    // request actually starts. This is after manual ROI selection, so the loader does
    // not appear while the user is still choosing an area, and before capture/API work.
    await showScreenshotAnswerLoader(tab.id);

    const { visionModel } = await getModels();

    if (settings.test_mode) {
      globalThis.TALogger.logAction('TEST MODE — screenshot mock');
      await sendToTab(tab.id, {
        type: 'SCREENSHOT_ANSWER_RESULT',
        payload: { ok: true, answer: 'b\n---\n🧪 Тест-режим: скриншот не отправлялся в API.', model: visionModel }
      });
      return;
    }

    const captureDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    if (!captureDataUrl) throw new Error('Не удалось получить скриншот вкладки.');

    const captureBitmap = await createImageBitmap(dataUrlToBlob(captureDataUrl));
    const captureSize = { width: captureBitmap.width, height: captureBitmap.height };
    captureBitmap.close?.();

    const profile = getScreenshotRequestProfile(visionModel, Boolean(roiRes?.roi), settings);
    globalThis.TALogger.logAction('Screenshot profile selected', {
      model: visionModel,
      timeoutMs: profile.timeoutMs,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      primaryOpt: profile.primaryOpt,
      fallbackOpt: profile.fallbackOpt,
      hasRoi: Boolean(roiRes?.roi),
      captureSize,
      viewport: roiRes?.viewport || null,
      roi: roiRes?.roi || null,
    });

    const mappedRoi = roiRes?.roi ? mapRoiToCapturePixels(roiRes.roi, roiRes.viewport, captureSize.width, captureSize.height) : null;
    const primaryDataUrl = await cropScreenshotToRoi(captureDataUrl, mappedRoi, profile.primaryOpt);
    const primarySizeBytes = Math.round(primaryDataUrl.length * 0.75);
    globalThis.TALogger.logAction('Screenshot optimized', { pass: 'primary', approxBytes: primarySizeBytes });

    let answer;
    try {
      answer = await fetchScreenshotAnswer(primaryDataUrl, ctrl.signal, profile);
    } catch (firstErr) {
      const retriable = firstErr?.retriable || /timeout|large|payload|413|429|5\d\d/i.test(String(firstErr?.message || ''));
      if (!retriable) throw firstErr;
      globalThis.TALogger.logError(firstErr, { source: 'screenshot-primary', retry: 'fallback-compress' });
      const fallbackDataUrl = await cropScreenshotToRoi(captureDataUrl, mappedRoi, profile.fallbackOpt);
      const fallbackSizeBytes = Math.round(fallbackDataUrl.length * 0.75);
      globalThis.TALogger.logAction('Screenshot optimized', { pass: 'fallback', approxBytes: fallbackSizeBytes });
      answer = await fetchScreenshotAnswer(fallbackDataUrl, ctrl.signal, profile);
    }

    await sendToTab(tab.id, {
      type: 'SCREENSHOT_ANSWER_RESULT',
      payload: { ok: true, answer, model: visionModel }
    });

    if (settings.multi_check_enabled) {
      try {
        const screenshotModels = Array.isArray(settings.screenshot_multi_check_models)
          ? settings.screenshot_multi_check_models.filter(Boolean)
          : [];
        if (screenshotModels.length) {
          const consensus = await runImageConsensusCheck({
            questionText: roiRes?.questionText || '',
            dataUrl: primaryDataUrl,
            models: screenshotModels,
            primaryAnswer: answer,
            profile,
          });
          const verdict = computeImageVerdict({
            originalAnswer: answer,
            consensus: consensus.consensus,
            judgeConfidence: consensus.judgeConfidence,
            judgeVerdict: consensus.judgeVerdict,
          });
          await sendToTab(tab.id, {
            type: 'SCREENSHOT_MULTI_RESULT',
            payload: { ok: true, ...consensus, verdict }
          });
        }
      } catch (e) {
        globalThis.TALogger.logError(e, { source: 'screenshot-multi-check' });
        await sendToTab(tab.id, {
          type: 'SCREENSHOT_MULTI_RESULT',
          payload: { ok: false, error: e?.message || 'Image multi-check failed' }
        });
      }
    }
  } catch (e) {
    if (e?.message === 'REPLACED') return;
    globalThis.TALogger.logError(e, { source: 'handleScreenshotFlow' });
    try {
      await sendToTab(tab.id, {
        type: 'SCREENSHOT_ANSWER_RESULT',
        payload: { ok: false, error: e.message || 'Ошибка скриншота' }
      });
    } catch {}
  } finally {
    if (activeController === ctrl) activeController = null;
    keepaliveStop();
  }
}
