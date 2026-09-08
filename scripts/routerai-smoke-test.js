#!/usr/bin/env node
/**
 * RouterAI smoke-test helper for QuizMind migration.
 *
 * Usage:
 *   ROUTERAI_API_KEY="..." node scripts/routerai-smoke-test.js
 *   ROUTERAI_API_KEY="..." ROUTERAI_MODEL="openai/gpt-4o" node scripts/routerai-smoke-test.js
 *
 * What it checks:
 *   1. GET /api/v1/models
 *   2. POST /api/v1/chat/completions
 *   3. Several possible balance/key endpoints, without assuming undocumented API shape.
 *
 * Notes:
 *   - This script never prints the API key.
 *   - Balance probing is intentionally read-only.
 */

const BASE_URL = process.env.ROUTERAI_BASE_URL || 'https://routerai.ru/api/v1';
const API_KEY = process.env.ROUTERAI_API_KEY || '';
const PREFERRED_MODEL = process.env.ROUTERAI_MODEL || '';
const TIMEOUT_MS = Number(process.env.ROUTERAI_TIMEOUT_MS || 30000);

if (!API_KEY.trim()) {
  console.error('Missing ROUTERAI_API_KEY environment variable.');
  process.exit(1);
}

function mask(value) {
  const s = String(value || '');
  if (s.length <= 10) return '<set>';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

async function request(path, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: response.ok, status: response.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeModels(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
  return list
    .map((m) => ({
      id: String(m?.id || m?.model || '').trim(),
      name: String(m?.name || m?.id || m?.model || '').trim(),
      architecture: m?.architecture || {},
      raw: m,
    }))
    .filter((m) => m.id);
}

function hasImageInput(model) {
  const input = model?.architecture?.input_modalities;
  if (Array.isArray(input)) return input.map(String).some((x) => x.toLowerCase() === 'image');
  const modality = String(model?.architecture?.modality || '');
  return modality.split('->')[0].toLowerCase().includes('image');
}

async function checkModels() {
  console.log('\n[1/3] Checking GET /models');
  const result = await request('/models');
  console.log(`GET /models -> HTTP ${result.status}`);
  if (!result.ok) {
    console.log(result.text.slice(0, 500));
    return { models: [], modelForChat: PREFERRED_MODEL || null };
  }

  const models = normalizeModels(result.json);
  const imageCount = models.filter(hasImageInput).length;
  console.log(`Parsed models: ${models.length}; vision-capable: ${imageCount}`);
  console.log('First 10 model ids:');
  for (const m of models.slice(0, 10)) console.log(`  - ${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ''}`);

  const modelForChat = PREFERRED_MODEL || models[0]?.id || null;
  return { models, modelForChat };
}

async function checkChat(model) {
  console.log('\n[2/3] Checking POST /chat/completions');
  if (!model) {
    console.log('Skipped: no model id available. Set ROUTERAI_MODEL manually.');
    return;
  }

  const payload = {
    model,
    messages: [
      { role: 'system', content: 'You are a concise test assistant.' },
      { role: 'user', content: 'Reply with exactly: OK' },
    ],
    temperature: 0,
    max_tokens: 16,
  };

  const result = await request('/chat/completions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  console.log(`POST /chat/completions model=${model} -> HTTP ${result.status}`);
  if (!result.ok) {
    console.log(result.text.slice(0, 800));
    return;
  }
  const content = result.json?.choices?.[0]?.message?.content ?? result.json?.choices?.[0]?.text ?? '';
  console.log(`Assistant content: ${JSON.stringify(content)}`);
}

async function probeBalanceEndpoints() {
  console.log('\n[3/3] Probing possible balance/key endpoints');
  const candidates = [
    '/balance',
    '/billing',
    '/credits',
    '/credit',
    '/usage',
    '/user',
    '/me',
    '/account',
    '/key',
    '/keys',
    '/api-keys',
    '/v1/key',
    '/v1/keys',
  ];

  const hits = [];
  for (const path of candidates) {
    const result = await request(path);
    const bodyPreview = (result.text || '').replace(/\s+/g, ' ').slice(0, 220);
    console.log(`${path.padEnd(12)} -> HTTP ${result.status}${bodyPreview ? ` | ${bodyPreview}` : ''}`);
    if (result.ok) hits.push({ path, status: result.status, json: result.json, preview: bodyPreview });
  }

  if (!hits.length) {
    console.log('No documented-looking balance endpoint found with normal API-key auth. Use RouterAI Billing UI unless docs provide a specific endpoint.');
  } else {
    console.log('\nSuccessful candidate endpoints:');
    for (const hit of hits) console.log(`  - ${hit.path} HTTP ${hit.status}`);
  }
}

(async () => {
  console.log('RouterAI smoke test');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`API key: ${mask(API_KEY)}`);

  const { modelForChat } = await checkModels();
  await checkChat(modelForChat);
  await probeBalanceEndpoints();
})();
