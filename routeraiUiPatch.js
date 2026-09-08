// routeraiUiPatch.js — small RouterAI wording patch for content-script UI surfaces.
// Popup/options pages should also use RouterAI wording via i18n.js/settings updates.

(() => {
  const apply = () => {
    try {
      document.querySelectorAll('[data-i18n="api.label"]').forEach((el) => { el.textContent = 'RouterAI API Key'; });
      document.querySelectorAll('[data-i18n="api.hint"]').forEach((el) => { el.textContent = 'Get your key in RouterAI Settings → API keys. Use it as Authorization: Bearer YOUR_API_KEY.'; });
      document.querySelectorAll('[data-i18n="models.list_empty"]').forEach((el) => { el.textContent = 'Model list is empty. Check your RouterAI API key and access.'; });
      const apiKeyInput = document.getElementById('apiKey');
      if (apiKeyInput) apiKeyInput.placeholder = 'RouterAI API key';
    } catch {}
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }
})();
