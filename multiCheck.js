/**
 * multiCheck.js — Multi-model consensus check engine (service worker only)
 *
 * Loaded via importScripts() in background.js.
 * Shares the service-worker global scope with background.js, so it can
 * reference fetchCompletion, buildSystemPrompt, getSettings,
 * getScreenshotRequestProfile, fetchScreenshotAnswer, keepOnlyFinalAnswer,
 * sleep, and globalThis.TAPromptsConfig / globalThis.TALogger directly.
 *
 * Public API (service-worker globals after importScripts):
 *   runTextConsensusCheck({ questionText, models, primaryAnswer })
 *   runImageConsensusCheck({ questionText, dataUrl, models, signal, settings })
 *   computeTextVerdict({ originalAnswer, consensus, judgeConfidence, judgeVerdict })
 *   computeImageVerdict({ originalAnswer, consensus, judgeConfidence, judgeVerdict })
 */

/* ─────────────────────── shared consensus utilities ─────────────── */

function normalizeForConsensus(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s*,\s*/g, ', ')  // normalise comma spacing: "a,c" → "a, c"; "a ,  c" → "a, c"
    .replace(/\s+/g, ' ');
}

function checkConsensus(answers) {
  if (!answers || answers.length < 2) return true;
  const normalized = answers.map(normalizeForConsensus).filter(Boolean);
  if (normalized.length === 0) return false;
  const first = normalized[0];
  return normalized.every(a => a === first);
}

function buildMajorityConsensus(answers = []) {
  const groups = new Map();
  for (const answer of answers) {
    const key = normalizeForConsensus(answer);
    if (!key) continue;
    const prev = groups.get(key) || { count: 0, sample: answer };
    prev.count += 1;
    groups.set(key, prev);
  }
  const ranked = [...groups.values()].sort((a, b) => b.count - a.count || String(b.sample).length - String(a.sample).length);
  return ranked[0]?.sample || answers[0] || '';
}

/* ─────────────────────── structured response parsers ─────────────── */

/**
 * Parses structured ANSWER/CONFIDENCE/REASON/VERDICT fields from a model's raw text response.
 * Used for both Round 1 structured answers and judge output in the text multi-check pipeline.
 *
 * Falls back gracefully: if the model didn't follow the structured format,
 * keepOnlyFinalAnswer() extracts whatever label or text was returned, and confidence defaults to 0.5.
 *
 * @param {string} raw — the raw completion text from the model
 * @returns {{ answer: string, confidence: number, reason: string, verdict: string|null }}
 */
function parseStructuredTextResponse(raw) {
  const text = String(raw || '').trim();
  const get  = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)`, 'im'));
    return m ? m[1].trim() : null;
  };

  const rawAnswer  = get('ANSWER');
  const rawConf    = get('CONFIDENCE');
  const rawReason  = get('REASON');
  const rawVerdict = get('VERDICT');

  const parsed     = rawConf !== null ? parseFloat(rawConf) : NaN;
  const confidence = isNaN(parsed) ? 0.5 : Math.min(1, Math.max(0, parsed));

  const verdictLow = String(rawVerdict || '').toLowerCase();
  const verdict    = ['correct', 'incorrect', 'uncertain'].includes(verdictLow) ? verdictLow : null;

  return {
    answer:     rawAnswer || keepOnlyFinalAnswer(text, 'answer'),
    confidence,
    reason:     rawReason || '',
    verdict,
  };
}

/**
 * Parses the structured plain-text format returned by image multicheck prompts.
 *
 * Expected format (each field on its own line):
 *   OBSERVED: <text>
 *   OPTIONS: <text>
 *   DIAGRAM: <text>
 *   ANSWER: <text>
 *   CONFIDENCE: <0.0-1.0>
 *   VERDICT: correct|incorrect|uncertain   (judge only)
 *   REASON: <text>
 *
 * Missing fields are returned as empty strings; CONFIDENCE defaults to 0.5.
 */
function parseStructuredImageResponse(raw) {
  const str = String(raw || '');
  const get = (key) => {
    const m = str.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'mi'));
    return m ? m[1].trim() : '';
  };
  const confStr = get('CONFIDENCE');
  const conf    = parseFloat(confStr);
  const answer  = get('ANSWER') || get('FINAL_ANSWER');
  const verdict = get('VERDICT').toLowerCase();
  return {
    observed:   get('OBSERVED'),
    options:    get('OPTIONS'),
    diagram:    get('DIAGRAM'),
    answer,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
    verdict:    ['correct', 'incorrect', 'uncertain'].includes(verdict) ? verdict : '',
    reason:     get('REASON'),
    raw:        str,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * IMAGE MULTI-CHECK PIPELINE
 * Round 1 (parallel structured analysis) → optional Debate (if disagreement)
 * → Vision judge (image + real question + structured evidence) → Verdict
 * ═══════════════════════════════════════════════════════════════════ */

/*
 * Minimum token floors for structured multicheck outputs.
 * User's screenshot_max_tokens setting is respected when it is HIGHER than the floor,
 * but the floor ensures the structured format (OBSERVED/OPTIONS/DIAGRAM/ANSWER/CONFIDENCE/REASON etc.)
 * is never cut off by a too-low user setting.
 */
const MULTICHECK_MIN_TOKENS_R1    = 700; // Round 1: full OBSERVED/OPTIONS/DIAGRAM/ANSWER/CONFIDENCE/REASON
const MULTICHECK_MIN_TOKENS_R2    = 500; // Round 2: OBSERVED/ANSWER/CONFIDENCE/REASON
const MULTICHECK_MIN_TOKENS_JUDGE = 300; // Judge:   ANSWER/CONFIDENCE/VERDICT/REASON

async function fetchScreenshotAnswerWithModel(dataUrl, signal, settings, modelId) {
  const profile = getScreenshotRequestProfile(modelId, false, settings);
  const answer = await fetchScreenshotAnswer(dataUrl, signal, profile, modelId);
  return String(answer || '').trim();
}

/**
 * Fetches a structured analysis from a single vision model.
 * Uses `mode='explain'` so keepOnlyFinalAnswer returns the full structured text.
 *
 * @returns {Promise<Object>} parsed structured response + modelId
 */
async function fetchScreenshotStructuredAnswer(dataUrl, signal, settings, modelId, questionText) {
  const profile    = getScreenshotRequestProfile(modelId, false, settings);
  const systemPr   = await globalThis.TAPromptsConfig.getPrompt('screenshot_multicheck_system');
  const userTpl    = await globalThis.TAPromptsConfig.getPrompt('screenshot_multicheck_user');
  const userText   = userTpl.replace('{QUESTION}', String(questionText || '').trim() || 'Analyze this screenshot and answer the question.');

  const raw = await fetchCompletion('screenshot', 'explain', modelId, [
    { role: 'system', content: systemPr },
    {
      role:    'user',
      content: [
        { type: 'text',      text: userText },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  /* FIX (B3): honour user's screenshot_max_tokens when it exceeds the structured-output floor;
     use user's screenshot_temperature instead of the hardcoded 0.1 */
  ], signal, {
    timeoutMs:   profile.timeoutMs,
    maxTokens:   Math.max(profile.maxTokens, MULTICHECK_MIN_TOKENS_R1),
    temperature: profile.temperature,
  });

  const parsed = parseStructuredImageResponse(raw);
  /* Fallback: if ANSWER field missing, use first non-empty line of raw output */
  if (!parsed.answer) {
    parsed.answer = raw.split('\n').map(l => l.trim()).find(Boolean) || '';
  }
  return { ...parsed, modelId };
}

/**
 * Debate round for image multicheck.
 * Each model receives: image + question + its own prior answer/reason + other models' answers.
 * Returns revised results array (same shape as round1, with revised=true where changed).
 */
async function fetchScreenshotDebateRound(questionText, dataUrl, signal, settings, round1Results) {
  const validResults = round1Results.filter(r => r.ok && r.answer);
  if (validResults.length < 2) return round1Results;

  /* FIX (B4): load debate system prompt from configurable registry instead of hardcoded inline */
  const debateSysPr = await globalThis.TAPromptsConfig.getPrompt('screenshot_debate_system');
  const debateTpl   = await globalThis.TAPromptsConfig.getPrompt('screenshot_debate_user');

  const debateResults = await Promise.allSettled(round1Results.map(async (entry) => {
    if (!entry.ok || !entry.answer) return entry;

    const others = validResults.filter(r => r.modelId !== entry.modelId);
    if (!others.length) return entry;

    const othersText = others.map(r => {
      const parts = [`Answer: ${r.answer}`];
      if (r.reason) parts.push(`Reasoning: ${r.reason}`);
      return parts.join('\n');
    }).join('\n---\n');

    const userText = debateTpl
      .replace('{QUESTION}',   String(questionText || '').trim() || 'Answer the question in the screenshot.')
      .replace('{OWN_ANSWER}', entry.answer)
      .replace('{OWN_REASON}', entry.reason || 'Not provided')
      .replace('{OTHERS}',     othersText);

    const profile = getScreenshotRequestProfile(entry.modelId, false, settings);

    try {
      /* FIX (B3): honour user token/temp settings with floor; FIX (B4): use configurable system prompt */
      const raw = await fetchCompletion('screenshot', 'explain', entry.modelId, [
        { role: 'system', content: debateSysPr },
        {
          role:    'user',
          content: [
            { type: 'text',      text: userText },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ], signal, {
        timeoutMs:   profile.timeoutMs,
        maxTokens:   Math.max(profile.maxTokens, MULTICHECK_MIN_TOKENS_R2),
        temperature: profile.temperature,
      });

      const parsed = parseStructuredImageResponse(raw);
      return {
        ...entry,
        answer:         parsed.answer         || entry.answer,
        confidence:     parsed.confidence      ?? entry.confidence,
        reason:         parsed.reason          || entry.reason  || '',
        observed:       parsed.observed        || entry.observed || '',
        revised:        true,
        originalAnswer: entry.answer,
      };
    } catch (e) {
      /* Debate failed for this model — keep original round1 entry */
      return { ...entry, debateError: e.message };
    }
  }));

  return debateResults.map((r, i) => r.status === 'fulfilled' ? r.value : round1Results[i]);
}

/**
 * Vision-capable judge.
 * Sends the image + real question + all models' structured evidence to the judge model.
 * Falls back to text-only judge (still has real question + extracted evidence), then majority.
 *
 * @returns {{ answer: string, confidence: number, verdict: string, reason: string }}
 */
async function buildImageJudgeConsensus(questionText, dataUrl, signal, structuredResults, settings) {
  const validResults = structuredResults.filter(r => r.ok !== false && r.answer);
  const answers      = validResults.map(r => r.answer);

  if (!validResults.length) return { answer: '', confidence: 0, verdict: 'uncertain', reason: 'No valid answers.' };
  if (validResults.length === 1) return { answer: validResults[0].answer, confidence: validResults[0].confidence || 0.5, verdict: 'uncertain', reason: 'Only one model responded.' };

  /* Full agreement after all rounds — trust it strongly */
  if (checkConsensus(answers)) {
    const avgConf = validResults.reduce((s, r) => s + (r.confidence || 0.5), 0) / validResults.length;
    return {
      answer:     answers[0],
      confidence: Math.max(0.72, avgConf),
      verdict:    'correct',
      reason:     'All models agreed on this answer.',
    };
  }

  const judgeModel = String(settings.widget_current_model || settings.model_text || '').trim();
  if (!judgeModel) {
    return { answer: buildMajorityConsensus(answers), confidence: 0.45, verdict: 'uncertain', reason: 'No judge model configured.' };
  }

  /* Build structured evidence block */
  const evidenceParts = validResults.map((r, idx) => {
    const lines = [`[Model ${idx + 1}]`];
    if (r.observed) lines.push(`Observed text: ${r.observed}`);
    if (r.options && r.options.toLowerCase() !== 'none')  lines.push(`Detected options: ${r.options}`);
    if (r.diagram && r.diagram.toLowerCase() !== 'none')  lines.push(`Diagram/scheme: ${r.diagram}`);
    lines.push(`Answer: ${r.answer}`);
    if (r.confidence !== undefined) lines.push(`Confidence: ${r.confidence}`);
    if (r.reason)                   lines.push(`Reason: ${r.reason}`);
    if (r.revised) lines.push(`(Revised from: ${r.originalAnswer})`);
    return lines.join('\n');
  }).join('\n\n---\n\n');

  const judgeTpl  = await globalThis.TAPromptsConfig.getPrompt('screenshot_judge_user');
  const userText  = judgeTpl
    .replace('{QUESTION}', String(questionText || '').trim() || 'Answer the question in the screenshot.')
    .replace('{EVIDENCE}', evidenceParts);

  /* FIX (B3): honour user token setting; keep temperature=0 for deterministic judging */
  const judgeProfile  = getScreenshotRequestProfile(judgeModel, false, settings);
  const judgeOpts     = {
    timeoutMs:   judgeProfile.timeoutMs,
    maxTokens:   Math.max(judgeProfile.maxTokens, MULTICHECK_MIN_TOKENS_JUDGE),
    temperature: 0,
  };

  /* FIX (B4): load judge system prompt from configurable registry */
  const judgeSysPr = await globalThis.TAPromptsConfig.getPrompt('screenshot_judge_system');

  /* Attempt 1: vision judge (image + evidence) */
  try {
    const raw = await fetchCompletion('screenshot', 'explain', judgeModel, [
      { role: 'system', content: judgeSysPr },
      {
        role:    'user',
        content: [
          { type: 'text',      text: userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ], signal, judgeOpts);

    const parsed      = parseStructuredImageResponse(raw);
    const finalAnswer = parsed.answer || buildMajorityConsensus(answers);
    const confidence  = parsed.confidence || 0.5;
    const verdict     = parsed.verdict || (confidence >= 0.65 ? 'correct' : 'uncertain');
    globalThis.TALogger.logAction('Image judge: vision attempt succeeded', { judgeModel, confidence, verdict });
    return { answer: finalAnswer, confidence, verdict, reason: parsed.reason || '' };
  } catch (visionErr) {
    /* FIX (B1): log when vision judge falls back — makes diagnostics visible */
    globalThis.TALogger.logAction('Image judge: vision attempt failed, falling back to text-only', {
      judgeModel,
      error: visionErr?.message || String(visionErr),
    });
  }

  /* Attempt 2: text-only judge (still has real question + extracted evidence) */
  try {
    const raw = await fetchCompletion('text', 'explain', judgeModel, [
      { role: 'system', content: judgeSysPr },
      { role: 'user',   content: userText },
    ], signal, judgeOpts);

    const parsed      = parseStructuredImageResponse(raw);
    const finalAnswer = parsed.answer || buildMajorityConsensus(answers);
    const confidence  = parsed.confidence || 0.45;
    const verdict     = parsed.verdict || (confidence >= 0.60 ? 'correct' : 'uncertain');
    globalThis.TALogger.logAction('Image judge: text-only attempt succeeded', { judgeModel, confidence, verdict });
    return { answer: finalAnswer, confidence, verdict, reason: parsed.reason || '' };
  } catch (textErr) {
    globalThis.TALogger.logAction('Image judge: both attempts failed, using majority fallback', {
      judgeModel,
      error: textErr?.message || String(textErr),
    });
  }

  return { answer: buildMajorityConsensus(answers), confidence: 0.4, verdict: 'uncertain', reason: 'Judge unavailable — majority fallback.' };
}

/**
 * Determines the final verdict label based on judge output and original answer.
 *
 * Thresholds:
 *   STRONG_CONFIDENCE >= 0.65 → can assert correct/incorrect
 *   WEAK_CONFIDENCE   <  0.40 → always uncertain
 *   Middle band (0.40–0.65):  match → correct, mismatch → uncertain (not confident enough to declare wrong)
 *
 * @returns {'correct'|'incorrect'|'uncertain'}
 */
function computeImageVerdict({ originalAnswer, consensus, judgeConfidence, judgeVerdict }) {
  const STRONG = 0.65;
  const WEAK   = 0.40;

  if (!consensus) return 'uncertain';
  if (judgeVerdict === 'uncertain' || judgeConfidence < WEAK) return 'uncertain';

  const norm = t => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');

  if (!originalAnswer) {
    /* No baseline to compare — rely purely on judge confidence */
    return judgeConfidence >= STRONG ? (judgeVerdict === 'incorrect' ? 'incorrect' : 'correct') : 'uncertain';
  }

  const answersMatch = norm(originalAnswer) === norm(consensus);

  if (judgeConfidence >= STRONG) {
    return answersMatch ? 'correct' : 'incorrect';
  }

  /* Middle confidence band */
  return answersMatch ? 'correct' : 'uncertain';
}

/**
 * Full image multicheck pipeline:
 *   Round 1 (parallel structured analysis)
 *   → Round 2 (image debate, only if answers differ)
 *   → Vision judge (image + real question + structured evidence)
 *   → Verdict computation
 *
 * Replaces the old runConsensusCheck() call for the screenshot path.
 */
async function runImageConsensusCheck({ questionText, dataUrl, models, signal, settings }) {
  /* ── Round 1: parallel structured analysis ── */
  const r1Raw = await Promise.allSettled(
    models.map(modelId => fetchScreenshotStructuredAnswer(dataUrl, signal, settings, modelId, questionText))
  );

  const round1 = r1Raw.map((r, i) => ({
    modelId:    models[i],
    ok:         r.status === 'fulfilled',
    answer:     r.status === 'fulfilled' ? (r.value.answer    || '') : '',
    confidence: r.status === 'fulfilled' ? (r.value.confidence ?? 0.5) : 0,
    reason:     r.status === 'fulfilled' ? (r.value.reason     || '') : '',
    observed:   r.status === 'fulfilled' ? (r.value.observed   || '') : '',
    options:    r.status === 'fulfilled' ? (r.value.options    || '') : '',
    diagram:    r.status === 'fulfilled' ? (r.value.diagram    || '') : '',
    error:      r.status === 'rejected'  ? (r.reason?.message  || 'Error') : null,
  }));

  const validAnswers = round1.filter(r => r.ok && r.answer).map(r => r.answer);
  if (!validAnswers.length) throw new Error('Ни одна модель не вернула корректный ответ (image multicheck).');

  /* ── Round 2: debate only when answers differ ── */
  const hasConsensus = checkConsensus(validAnswers);
  let round2       = null;
  let finalResults = round1;

  if (!hasConsensus) {
    globalThis.TALogger.logAction('Image multicheck: disagreement detected, starting debate round', {
      answers: validAnswers,
    });
    round2       = await fetchScreenshotDebateRound(questionText, dataUrl, signal, settings, round1);
    finalResults = round2;
  }

  /* ── Judge: vision-capable, sees image + question + evidence ── */
  const judgeResult = await buildImageJudgeConsensus(questionText, dataUrl, signal, finalResults, settings);

  globalThis.TALogger.logAction('Image multicheck done', {
    debated:    Boolean(round2),
    confidence: judgeResult.confidence,
    consensus:  judgeResult.answer,
  });

  /*
   * FIX (C2): removed internal `verdict` and `originalAnswer` from return — they were
   * immediately overridden in handleScreenshotFlow() and were misleading dead fields.
   * The caller recomputes verdict using baseAnswer (the default model answer shown to user).
   */
  return {
    round1,
    round2,
    finalResults,
    consensus:       judgeResult.answer,
    confidence:      judgeResult.confidence,
    judgeRawVerdict: judgeResult.verdict,
    judgeReason:     judgeResult.reason,
    debated:         Boolean(round2),
    comparedCount:   validAnswers.length,
    totalModels:     models.length,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * STRUCTURED TEXT MULTI-CHECK PIPELINE
 * Mirrors the image pipeline: Round 1 → optional Debate → Judge → Verdict
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Round 1: ask one text model for a structured ANSWER/CONFIDENCE/REASON response.
 * No cache — we want independent answers from each model.
 */
async function fetchTextStructuredAnswer(questionText, modelId, settings) {
  if (settings.test_mode) {
    await sleep(300 + Math.random() * 700);
    const MOCKS = ['a', 'b', 'c', 'd', 'a, c'];
    const ans   = MOCKS[Math.floor(Math.random() * MOCKS.length)];
    return { modelId, ok: true, answer: ans, confidence: 0.7 + Math.random() * 0.3, reason: 'Test mode mock.' };
  }

  const sysPrompt  = await globalThis.TAPromptsConfig.getPrompt('text_multicheck_system');
  const userTmpl   = await globalThis.TAPromptsConfig.getPrompt('text_multicheck_user');
  const userPrompt = userTmpl.replace('{QUESTION}', questionText);

  const raw    = await fetchCompletion('text', 'answer', modelId, [
    { role: 'system', content: sysPrompt },
    { role: 'user',   content: userPrompt },
  ]);
  const parsed = parseStructuredTextResponse(raw);
  return { modelId, ok: true, ...parsed };
}

/**
 * Debate Round: each model receives its own previous answer + reasoning
 * and the other models' structured answers, then revises or defends.
 * Returns the same array shape with updated answer/confidence/reason fields.
 */
async function fetchTextDebateRound(questionText, round1Results) {
  const valid = round1Results.filter(r => r.ok && r.answer);
  if (valid.length < 2) return round1Results;

  const settings   = await getSettings();
  const sysPrompt  = await globalThis.TAPromptsConfig.getPrompt('text_multicheck_system');
  const debateTmpl = await globalThis.TAPromptsConfig.getPrompt('text_debate_user');

  const debateResults = await Promise.allSettled(round1Results.map(async (entry) => {
    if (!entry.ok || !entry.answer) return entry;

    const others = valid.filter(r => r.modelId !== entry.modelId);
    if (!others.length) return entry;

    const othersText = others.map(r =>
      `Model (${r.modelId}):\nANSWER: ${r.answer}\nREASON: ${r.reason || 'not provided'}`
    ).join('\n---\n');

    const prompt = debateTmpl
      .replace('{QUESTION}',   questionText)
      .replace('{OWN_ANSWER}', entry.answer)
      .replace('{OWN_REASON}', entry.reason || 'not provided')
      .replace('{OTHERS}',     othersText);

    try {
      if (settings.test_mode) {
        await sleep(200 + Math.random() * 400);
        const MOCKS = ['a', 'b', 'c', 'd'];
        const ans   = MOCKS[Math.floor(Math.random() * MOCKS.length)];
        return { ...entry, answer: ans, confidence: 0.6 + Math.random() * 0.4, reason: 'Test mode revised.', revised: true };
      }

      const raw    = await fetchCompletion('text', 'answer', entry.modelId, [
        { role: 'system', content: sysPrompt },
        { role: 'user',   content: prompt },
      ]);
      const parsed = parseStructuredTextResponse(raw);
      return { ...entry, ...parsed, revised: true, originalAnswer: entry.answer };
    } catch (e) {
      return { ...entry, error: `Debate failed: ${e.message}` };
    }
  }));

  const mapped         = debateResults.map((r, i) => r.status === 'fulfilled' ? r.value : round1Results[i]);
  const revisionCount  = mapped.filter(r => r.revised && r.answer !== r.originalAnswer).length;
  globalThis.TALogger.logAction('Text structured debate done', { modelsCount: valid.length, revisionCount });
  return mapped;
}

/**
 * Judge: consumes all models' structured evidence (ANSWER/CONFIDENCE/REASON) and
 * returns a single best answer with confidence and verdict signal.
 *
 * Falls back to majority vote on any API error or empty response.
 *
 * @returns {{ answer: string, confidence: number, verdict: string|null, reason: string }}
 */
async function buildTextJudgeConsensus(questionText, structuredResults) {
  const nonEmpty = structuredResults.filter(r => r.ok && r.answer);
  if (!nonEmpty.length) return { answer: '', confidence: 0, verdict: 'uncertain', reason: '' };
  if (nonEmpty.length === 1) {
    const r = nonEmpty[0];
    return { answer: r.answer, confidence: r.confidence ?? 0.5, verdict: 'uncertain', reason: r.reason || '' };
  }

  const settings   = await getSettings();
  const judgeModel = String(settings.widget_current_model || settings.model_text || '').trim();
  if (!judgeModel) {
    globalThis.TALogger.logAction('Text judge: no model configured, using majority fallback');
    return {
      answer:     buildMajorityConsensus(nonEmpty.map(r => r.answer)),
      confidence: 0.4,
      verdict:    'uncertain',
      reason:     'No judge model configured.',
    };
  }

  const evidence = nonEmpty.map((r, i) =>
    `Model ${i + 1} (${r.modelId}):\nANSWER: ${r.answer}\nCONFIDENCE: ${r.confidence ?? '?'}\nREASON: ${r.reason || 'not provided'}`
  ).join('\n\n---\n\n');

  const judgeSystemPrompt = await globalThis.TAPromptsConfig.getPrompt('judge_system');
  const judgeUserTmpl     = await globalThis.TAPromptsConfig.getPrompt('text_judge_user');
  const judgePrompt       = judgeUserTmpl
    .replace('{QUESTION}', questionText)
    .replace('{EVIDENCE}', evidence);

  try {
    const raw    = await fetchCompletion('text', 'explain', judgeModel, [
      { role: 'system', content: judgeSystemPrompt },
      { role: 'user',   content: judgePrompt },
    ]);
    const parsed = parseStructuredTextResponse(raw);

    if (!parsed.answer) {
      globalThis.TALogger.logAction('Text judge: empty response, using majority fallback', { judgeModel });
      return {
        answer:     buildMajorityConsensus(nonEmpty.map(r => r.answer)),
        confidence: 0.4,
        verdict:    'uncertain',
        reason:     'Judge returned empty answer.',
      };
    }

    globalThis.TALogger.logAction('Text judge: consensus accepted', {
      judgeModel,
      answer:     parsed.answer,
      confidence: parsed.confidence,
      verdict:    parsed.verdict,   // may be null if model didn't follow format
      reason:     parsed.reason,
    });
    return {
      answer:     parsed.answer,
      confidence: parsed.confidence,
      verdict:    parsed.verdict,   // may be null if model didn't follow format
      reason:     parsed.reason,
    };
  } catch (e) {
    globalThis.TALogger.logAction('Text judge: exception, using majority fallback', { judgeModel, error: e?.message });
    return {
      answer:     buildMajorityConsensus(nonEmpty.map(r => r.answer)),
      confidence: 0.3,
      verdict:    'uncertain',
      reason:     `Judge error: ${e.message}`,
    };
  }
}

/** Confidence thresholds — mirrors IMAGE_VERDICT_THRESHOLDS in the image pipeline */
const TEXT_VERDICT_THRESHOLDS = { STRONG: 0.65, WEAK: 0.40 };

/**
 * Computes the final user-facing verdict by combining:
 *  - The judge's own confidence score
 *  - The judge's explicit verdict signal (if present)
 *  - Whether the consensus matches the original (primary) answer
 *
 * Mirrors computeImageVerdict() logic.
 *
 * @returns {'correct'|'incorrect'|'uncertain'}
 */
function computeTextVerdict({ originalAnswer, consensus, judgeConfidence, judgeVerdict }) {
  const conf = typeof judgeConfidence === 'number' ? judgeConfidence : 0;

  // Judge explicitly says uncertain, or confidence is below the weak threshold → uncertain
  if (judgeVerdict === 'uncertain' || conf < TEXT_VERDICT_THRESHOLDS.WEAK) return 'uncertain';

  const normalize = (s) =>
    String(s || '').trim().toLowerCase().replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ');

  const origNorm = normalize(originalAnswer);
  const consNorm = normalize(consensus);
  const match    = Boolean(origNorm && consNorm && origNorm === consNorm);

  // Strong confidence: give a definitive verdict
  if (conf >= TEXT_VERDICT_THRESHOLDS.STRONG) return match ? 'correct' : 'incorrect';

  // Weak-but-above-floor confidence: only say correct if they match, else uncertain
  return match ? 'correct' : 'uncertain';
}

/**
 * Top-level text multi-check pipeline (structured).
 * Replaces the old runConsensusCheck() path for GET_MULTI_CONSENSUS.
 *
 * Flow: Round 1 parallel → optional Debate (if disagreement) → Judge → Verdict
 *
 * @param {{ questionText: string, models: string[], primaryAnswer?: string }} params
 * @returns structured result ready for sendResponse
 */
async function runTextConsensusCheck({ questionText, models, primaryAnswer = '' }) {
  const settings = await getSettings();

  /* ── Round 1: structured answers from all models in parallel ── */
  const round1Raw = await Promise.allSettled(
    models.map(async (modelId) => fetchTextStructuredAnswer(questionText, modelId, settings))
  );

  const round1 = round1Raw.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { modelId: models[i], ok: false, answer: null, confidence: 0, reason: '', error: r.reason?.message || 'Error' };
  });

  const valid1 = round1.filter(r => r.ok && r.answer);
  if (!valid1.length) throw new Error('Ни одна модель не вернула корректный ответ.');

  /* ── Optional Debate Round: triggered when models disagree ── */
  const r1Answers    = valid1.map(r => r.answer);
  const hasConsensus = checkConsensus(r1Answers);

  let round2  = null;
  let debated = false;
  if (!hasConsensus) {
    round2  = await fetchTextDebateRound(questionText, round1);
    debated = true;
  }

  /* ── Judge: consume structured evidence, pick best answer ── */
  const finalResults = round2 || round1;
  const judgeResult  = await buildTextJudgeConsensus(questionText, finalResults);

  if (!judgeResult.answer) throw new Error('Не удалось собрать итоговый consensus.');

  /* ── Verdict is computed client-side via GET_TEXT_VERDICT once the resolved primary
   * answer is available. Returning raw judge data keeps computeTextVerdict() as the
   * single source of truth without requiring primaryAnswer here. ── */
  return {
    round1,
    round2,
    consensus:    judgeResult.answer,
    confidence:   judgeResult.confidence,
    judgeVerdict: judgeResult.verdict, // raw judge signal forwarded to GET_TEXT_VERDICT
    judgeReason:  judgeResult.reason,
    debated,
    comparedCount: valid1.length,
    totalModels:   models.length,
  };
}
