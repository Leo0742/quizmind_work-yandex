(() => {
  const MODEL_DISPLAY_NAMES = {
    'deepseek/deepseek-v4-flash':             'DeepSeek: DeepSeek V4 Flash',
    'openai/gpt-5.5':                         'OpenAI: GPT-5.5',
    'openai/gpt-5.3-chat':                    'OpenAI: GPT-5.3 Chat',
    'google/gemini-3.1-pro-preview':          'Google: Gemini 3.1 Pro Preview',
    'google/gemini-3.1-flash-lite-preview':   'Google: Gemini 3.1 Flash Lite Preview',
    'qwen/qwen3-max-thinking':                'Qwen: Qwen3 Max Thinking',
    'deepseek/deepseek-v3.2':                 'DeepSeek: DeepSeek V3.2',
  };

  const CACHE_KEY_CHAT  = 'models_cache_chat';
  const CACHE_KEY_IMAGE = 'models_cache_image';
  const CACHE_TS_KEY_CHAT  = 'models_cache_timestamp_chat';
  const CACHE_TS_KEY_IMAGE = 'models_cache_timestamp_image';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const ROUTERAI_BASE_URL = 'https://routerai.ru/api/v1';
  const MODELS_BASE_URL = `${ROUTERAI_BASE_URL}/models`;

  function getCacheKeys(type) {
    if (type === 'image') return { cacheKey: CACHE_KEY_IMAGE, tsKey: CACHE_TS_KEY_IMAGE };
    return { cacheKey: CACHE_KEY_CHAT, tsKey: CACHE_TS_KEY_CHAT };
  }

  async function getApiKey() {
    const data = await chrome.storage.local.get(['routeraiApiKey']);
    return String(data.routeraiApiKey || '').trim();
  }

  function normalizeModelsPayload(payload) {
    const base = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
    return base
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id:                String(item.id || item.model || '').trim(),
        name:              String(item.name || item.id || item.model || '').trim(),
        type:              String(item.type || '').trim().toLowerCase(),
        short_description: String(item.description || item.short_description || '').trim(),
        architecture:      item.architecture && typeof item.architecture === 'object' ? item.architecture : {},
      }))
      .filter((item) => item.id);
  }

  function ensureUniqueById(models) {
    const seen = new Set();
    const out = [];
    for (const model of models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      out.push(model);
    }
    return out;
  }

  async function readCache(type = 'chat') {
    const { cacheKey, tsKey } = getCacheKeys(type);
    const data = await chrome.storage.local.get([cacheKey, tsKey]);
    const models = Array.isArray(data[cacheKey]) ? data[cacheKey] : [];
    const ts = Number(data[tsKey] || 0);
    return { models, ts };
  }

  async function writeCache(models, type = 'chat') {
    const { cacheKey, tsKey } = getCacheKeys(type);
    await chrome.storage.local.set({
      [cacheKey]: models,
      [tsKey]: Date.now(),
    });
  }

  async function fetchModelsFromApi(apiKey, type = 'chat') {
    const resp = await fetch(MODELS_BASE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) {
      throw new Error(`Ошибка загрузки моделей RouterAI: ${resp.status}`);
    }
    const data = await resp.json();
    const allModels = ensureUniqueById(normalizeModelsPayload(data));

    if (type === 'image') return filterVisionModels(allModels);
    return filterTextModels(allModels);
  }

  function searchModels(models, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [...models];
    return models.filter((model) => {
      const id = model.id.toLowerCase();
      const name = String(model.name || '').toLowerCase();
      const desc = String(model.short_description || '').toLowerCase();
      return id.includes(q) || name.includes(q) || desc.includes(q);
    });
  }

  function filterTextModels(models) {
    return models.filter((m) => {
      const outputModalities = m?.architecture?.output_modalities;
      if (Array.isArray(outputModalities)) {
        return outputModalities.some((mod) => String(mod).toLowerCase() === 'text');
      }
      const modality = String(m?.architecture?.modality || '');
      if (!modality) return true;
      const outputPart = modality.split('->')[1] || '';
      return outputPart.toLowerCase().includes('text');
    });
  }

  function filterVisionModels(models) {
    return models.filter((m) => {
      const inputModalities = m?.architecture?.input_modalities;
      if (Array.isArray(inputModalities)) {
        return inputModalities.some((mod) => String(mod).toLowerCase() === 'image');
      }
      const modality = String(m?.architecture?.modality || '');
      if (!modality) return false;
      const inputPart = modality.split('->')[0] || modality;
      return inputPart.toLowerCase().includes('image');
    });
  }

  function sortByFavorites(models, favorites = []) {
    const favSet = new Set((favorites || []).map(String));
    return [...models].sort((a, b) => {
      const af = favSet.has(a.id) ? 0 : 1;
      const bf = favSet.has(b.id) ? 0 : 1;
      if (af !== bf) return af - bf;
      return a.id.localeCompare(b.id);
    });
  }

  async function getModels({ type = 'chat', forceRefresh = false } = {}) {
    const { models: cachedModels, ts } = await readCache(type);
    const cacheValid = cachedModels.length > 0 && (Date.now() - ts) < CACHE_TTL_MS;
    if (!forceRefresh && cacheValid) {
      return { models: cachedModels, fromCache: true, cacheAgeMs: Date.now() - ts };
    }

    const apiKey = await getApiKey();
    if (!apiKey) {
      return {
        models: cachedModels,
        fromCache: cachedModels.length > 0,
        cacheAgeMs: ts ? Date.now() - ts : null,
        error: 'API ключ не указан. Добавьте RouterAI API key.',
      };
    }

    try {
      const models = await fetchModelsFromApi(apiKey, type);
      if (models.length) await writeCache(models, type);
      return { models, fromCache: false, cacheAgeMs: 0 };
    } catch (error) {
      if (cachedModels.length) {
        return {
          models: cachedModels,
          fromCache: true,
          cacheAgeMs: ts ? Date.now() - ts : null,
          error: `Using cached models. ${error.message || 'Ошибка API.'}`,
        };
      }
      throw error;
    }
  }

  async function getFavoriteModels() {
    const data = await chrome.storage.local.get(['taSettings']);
    const settings = data?.taSettings || {};
    const fromNew = Array.isArray(settings.model_favorites) ? settings.model_favorites : null;
    const fromLegacy = Array.isArray(settings.favorite_models) ? settings.favorite_models : [];
    return fromNew || fromLegacy;
  }

  async function setFavoriteModels(favorites) {
    const data = await chrome.storage.local.get(['taSettings']);
    const current = data?.taSettings || {};
    const normalized = [...new Set((Array.isArray(favorites) ? favorites : []).map(String))];
    await chrome.storage.local.set({
      taSettings: {
        ...current,
        model_favorites: normalized,
        favorite_models: normalized,
      },
    });
    return normalized;
  }

  globalThis.TAModelsService = {
    MODEL_DISPLAY_NAMES,
    CACHE_KEY_CHAT,
    CACHE_KEY_IMAGE,
    CACHE_TS_KEY_CHAT,
    CACHE_TS_KEY_IMAGE,
    CACHE_TTL_MS,
    MODELS_BASE_URL,
    getApiKey,
    getModels,
    searchModels,
    filterTextModels,
    filterVisionModels,
    sortByFavorites,
    normalizeModelsPayload,
    getFavoriteModels,
    setFavoriteModels,
  };
})();
