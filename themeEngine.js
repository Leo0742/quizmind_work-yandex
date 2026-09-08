/**
 * themeEngine.js — QuizMind Theme Engine v1.0
 *
 * Exposes globalThis.TAThemeEngine with:
 *   TOKEN_KEYS           — ordered list of CSS variable names
 *   PRESETS              — built-in theme presets
 *   PRESET_NAMES         — array of preset keys
 *   getPreset(name)      — get preset definition by key
 *   generateVars(preset, overrides) → merged {token: value} object
 *   toCSS(vars)          → CSS variable string for injection
 *   applyToShadowRoot(sr, vars)     — inject/update <style> in shadow root
 *   applyFromSettings(settings, surface, sr) — full apply with settings
 *   detectChameleon(x, y, strength) → vars object or null
 *   applyToDocumentRoot(vars)       — apply vars to document :root
 */

(() => {
  /* ── Token definitions ────────────────────────────────────────── */

  const TOKEN_KEYS = [
    '--qm-bg',
    '--qm-surface',
    '--qm-surface-2',
    '--qm-border',
    '--qm-text',
    '--qm-text-2',
    '--qm-muted',
    '--qm-accent',
    '--qm-accent-light',
    '--qm-success',
    '--qm-radius',
    '--qm-shadow',
    '--qm-blur',
    '--qm-header-bg',
    '--qm-input-bg',
    '--qm-toggle-off',
    '--qm-icon-filter',
    '--qm-logo-filter',
  ];

  /* ── Token human labels (for the settings UI) ─────────────────── */

  const TOKEN_LABELS = {
    '--qm-bg':           { key: 'themes.token_bg',           label: 'Background' },
    '--qm-surface':      { key: 'themes.token_surface',       label: 'Panel / Card' },
    '--qm-surface-2':    { key: 'themes.token_surface2',      label: 'Header Surface' },
    '--qm-border':       { key: 'themes.token_border',        label: 'Border' },
    '--qm-text':         { key: 'themes.token_text',          label: 'Primary Text' },
    '--qm-text-2':       { key: 'themes.token_text2',         label: 'Secondary Text' },
    '--qm-muted':        { key: 'themes.token_muted',         label: 'Muted / Hint' },
    '--qm-accent':       { key: 'themes.token_accent',        label: 'Accent Color' },
    '--qm-accent-light': { key: 'themes.token_accent_light',  label: 'Accent Background' },
    '--qm-success':      { key: 'themes.token_success',       label: 'Success Color' },
    '--qm-radius':       { key: 'themes.token_radius',        label: 'Corner Radius' },
    '--qm-shadow':       { key: 'themes.token_shadow',        label: 'Shadow' },
    '--qm-blur':         { key: 'themes.token_blur',          label: 'Blur / Glass' },
    '--qm-header-bg':    { key: 'themes.token_header_bg',     label: 'Header Background' },
    '--qm-input-bg':     { key: 'themes.token_input_bg',      label: 'Input Background' },
    '--qm-toggle-off':   { key: 'themes.token_toggle_off',    label: 'Toggle Off Color' },
  };

  /* ── Color tokens (for simple <input type="color"> pickers) ────── */
  // These are the color-only tokens (not blur/radius/shadow)
  const COLOR_TOKEN_KEYS = [
    '--qm-bg',
    '--qm-surface',
    '--qm-border',
    '--qm-text',
    '--qm-text-2',
    '--qm-muted',
    '--qm-accent',
    '--qm-success',
  ];

  /* ── Built-in presets ─────────────────────────────────────────── */

  const PRESETS = {
    default: {
      label: 'Default',
      labelKey: 'themes.preset_default',
      preview: { bg: '#f0f6ff', surface: 'rgba(255,255,255,0.72)', accent: '#2563eb' },
      vars: {
        '--qm-bg':           'linear-gradient(135deg,#eef4ff 0%,#e8f0fe 50%,#f0eeff 100%)',
        '--qm-surface':      'rgba(255,255,255,0.72)',
        '--qm-surface-2':    'rgba(255,255,255,0.84)',
        '--qm-border':       'rgba(255,255,255,0.72)',
        '--qm-text':         '#0f172a',
        '--qm-text-2':       '#334155',
        '--qm-muted':        '#64748b',
        '--qm-accent':       '#2563eb',
        '--qm-accent-light': 'rgba(219,234,254,0.82)',
        '--qm-success':      '#16a34a',
        '--qm-radius':       '16px',
        '--qm-shadow':       '0 16px 44px rgba(15,23,42,0.14)',
        '--qm-blur':         '18px',
        '--qm-header-bg':    'rgba(255,255,255,0.65)',
        '--qm-input-bg':     'rgba(255,255,255,0.90)',
        '--qm-toggle-off':   '#b8c5d8',
        '--qm-icon-filter':  'none',
        '--qm-logo-filter':  'none',
      },
    },

    light: {
      label: 'Light',
      labelKey: 'themes.preset_light',
      preview: { bg: '#f1f5f9', surface: '#ffffff', accent: '#3b82f6' },
      vars: {
        '--qm-bg':           '#f1f5f9',
        '--qm-surface':      '#ffffff',
        '--qm-surface-2':    '#f8fafc',
        '--qm-border':       '#e2e8f0',
        '--qm-text':         '#1e293b',
        '--qm-text-2':       '#475569',
        '--qm-muted':        '#94a3b8',
        '--qm-accent':       '#3b82f6',
        '--qm-accent-light': '#dbeafe',
        '--qm-success':      '#22c55e',
        '--qm-radius':       '10px',
        '--qm-shadow':       '0 4px 12px rgba(0,0,0,0.08)',
        '--qm-blur':         '0px',
        '--qm-header-bg':    '#f8fafc',
        '--qm-input-bg':     '#ffffff',
        '--qm-toggle-off':   '#cbd5e1',
        '--qm-icon-filter':  'none',
        '--qm-logo-filter':  'none',
      },
    },

    dark: {
      label: 'Dark',
      labelKey: 'themes.preset_dark',
      preview: { bg: '#0f172a', surface: 'rgba(30,41,59,0.95)', accent: '#60a5fa' },
      vars: {
        '--qm-bg':           '#0f172a',
        '--qm-surface':      'rgba(30,41,59,0.95)',
        '--qm-surface-2':    'rgba(51,65,85,0.92)',
        '--qm-border':       'rgba(71,85,105,0.8)',
        '--qm-text':         '#f1f5f9',
        '--qm-text-2':       '#cbd5e1',
        '--qm-muted':        '#94a3b8',
        '--qm-accent':       '#60a5fa',
        '--qm-accent-light': 'rgba(96,165,250,0.15)',
        '--qm-success':      '#4ade80',
        '--qm-radius':       '12px',
        '--qm-shadow':       '0 10px 28px rgba(0,0,0,0.4)',
        '--qm-blur':         '12px',
        '--qm-header-bg':    'rgba(15,23,42,0.97)',
        '--qm-input-bg':     'rgba(30,41,59,0.9)',
        '--qm-toggle-off':   '#475569',
        '--qm-icon-filter':  'invert(1) brightness(1.5)',
        // Normalise dark fills → white → sepia → hue-rotate to blue accent (#60a5fa)
        '--qm-logo-filter':  'brightness(0) invert(1) sepia(1) saturate(3) hue-rotate(190deg) opacity(0.92)',
      },
    },

    glass: {
      label: 'Glass',
      labelKey: 'themes.preset_glass',
      preview: { bg: 'rgba(219,234,254,0.35)', surface: 'rgba(255,255,255,0.62)', accent: '#2563eb' },
      vars: {
        '--qm-bg':           'linear-gradient(135deg,rgba(232,240,254,0.5) 0%,rgba(219,234,254,0.35) 50%,rgba(237,233,254,0.45) 100%)',
        '--qm-surface':      'rgba(255,255,255,0.62)',
        '--qm-surface-2':    'rgba(255,255,255,0.78)',
        '--qm-border':       'rgba(255,255,255,0.72)',
        '--qm-text':         '#0f172a',
        '--qm-text-2':       '#334155',
        '--qm-muted':        '#64748b',
        '--qm-accent':       '#2563eb',
        '--qm-accent-light': 'rgba(219,234,254,0.82)',
        '--qm-success':      '#16a34a',
        '--qm-radius':       '18px',
        '--qm-shadow':       '0 20px 52px rgba(15,23,42,0.18)',
        '--qm-blur':         '22px',
        '--qm-header-bg':    'rgba(255,255,255,0.65)',
        '--qm-input-bg':     'rgba(255,255,255,0.88)',
        '--qm-toggle-off':   '#b8c5d8',
        '--qm-icon-filter':  'none',
        '--qm-logo-filter':  'none',
      },
    },

    'soft-blue': {
      label: 'Soft Blue',
      labelKey: 'themes.preset_soft_blue',
      preview: { bg: '#dbeafe', surface: 'rgba(239,246,255,0.94)', accent: '#2563eb' },
      vars: {
        '--qm-bg':           '#dbeafe',
        '--qm-surface':      'rgba(239,246,255,0.94)',
        '--qm-surface-2':    'rgba(255,255,255,0.92)',
        '--qm-border':       'rgba(191,219,254,0.9)',
        '--qm-text':         '#1e3a8a',
        '--qm-text-2':       '#1d4ed8',
        '--qm-muted':        '#3b82f6',
        '--qm-accent':       '#2563eb',
        '--qm-accent-light': '#bfdbfe',
        '--qm-success':      '#16a34a',
        '--qm-radius':       '14px',
        '--qm-shadow':       '0 8px 24px rgba(37,99,235,0.15)',
        '--qm-blur':         '10px',
        '--qm-header-bg':    'rgba(219,234,254,0.9)',
        '--qm-input-bg':     '#ffffff',
        '--qm-toggle-off':   '#93c5fd',
        '--qm-icon-filter':  'none',
        '--qm-logo-filter':  'none',
      },
    },

    'high-contrast': {
      label: 'High Contrast',
      labelKey: 'themes.preset_high_contrast',
      preview: { bg: '#000000', surface: '#1a1a1a', accent: '#facc15' },
      vars: {
        '--qm-bg':           '#000000',
        '--qm-surface':      '#1a1a1a',
        '--qm-surface-2':    '#2d2d2d',
        '--qm-border':       '#4d4d4d',
        '--qm-text':         '#ffffff',
        '--qm-text-2':       '#e5e5e5',
        '--qm-muted':        '#a3a3a3',
        '--qm-accent':       '#facc15',
        '--qm-accent-light': 'rgba(250,204,21,0.15)',
        '--qm-success':      '#86efac',
        '--qm-radius':       '8px',
        '--qm-shadow':       '0 4px 16px rgba(0,0,0,0.8)',
        '--qm-blur':         '0px',
        '--qm-header-bg':    '#111111',
        '--qm-input-bg':     '#2d2d2d',
        '--qm-toggle-off':   '#4d4d4d',
        '--qm-icon-filter':  'invert(1) brightness(2)',
        // Normalise dark fills → white → sepia → saturate toward yellow accent (#facc15)
        '--qm-logo-filter':  'brightness(0) invert(1) sepia(1) saturate(6) hue-rotate(5deg) opacity(0.95)',
      },
    },
  };

  const PRESET_NAMES = Object.keys(PRESETS);

  /* ── Accessors ────────────────────────────────────────────────── */

  function getPreset(name) {
    return PRESETS[name] || PRESETS['default'];
  }

  /**
   * Merge preset vars with custom overrides.
   * @param {string} presetName
   * @param {Object} [customOverrides]  optional {token: value} object
   * @returns {Object} merged vars
   */
  function generateVars(presetName, customOverrides) {
    const preset = getPreset(presetName);
    const vars = { ...preset.vars };
    if (customOverrides && typeof customOverrides === 'object') {
      for (const [k, v] of Object.entries(customOverrides)) {
        if (v !== undefined && v !== null && v !== '') vars[k] = v;
      }
    }
    return vars;
  }

  /** Convert vars object to CSS variable declarations string. */
  function toCSS(vars) {
    return Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
  }

  /* ── Shadow root injection ────────────────────────────────────── */

  /**
   * Inject or update a <style id="qm-theme-vars"> in a shadow root.
   * The style sets :host { --qm-*: value; }
   */
  function applyToShadowRoot(shadowRoot, vars) {
    if (!shadowRoot) return;
    const STYLE_ID = 'qm-theme-vars';

    let styleEl = null;
    for (const el of shadowRoot.querySelectorAll('style')) {
      if (el.id === STYLE_ID) { styleEl = el; break; }
    }

    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      // Insert at the very beginning so existing CSS can selectively override
      shadowRoot.insertBefore(styleEl, shadowRoot.firstChild);
    }

    styleEl.textContent = `:host{${toCSS(vars)}}`;
  }

  /**
   * Remove theme override from shadow root (reset to defaults).
   */
  function removeFromShadowRoot(shadowRoot) {
    if (!shadowRoot) return;
    for (const el of shadowRoot.querySelectorAll('#qm-theme-vars')) {
      el.remove();
    }
  }

  /**
   * Apply theme to a shadow root based on full settings object + surface name.
   * @param {Object} settings  full settings from storage
   * @param {string} surface   'widget' | 'popup' | 'settings' | 'inpage'
   * @param {ShadowRoot} shadowRoot
   */
  function applyFromSettings(settings, surface, shadowRoot) {
    if (!settings || !settings.theme_enabled) {
      removeFromShadowRoot(shadowRoot);
      return;
    }

    let presetName, customOverrides;

    if (settings.theme_scope === 'per_surface') {
      const surfaceConf = settings.theme_surfaces?.[surface] || {};
      presetName = surfaceConf.preset || 'default';
      customOverrides = surfaceConf.custom || {};
    } else {
      // global
      presetName = settings.theme_global_preset || 'default';
      customOverrides = settings.theme_global_custom || {};
    }

    const vars = generateVars(presetName, customOverrides);
    applyToShadowRoot(shadowRoot, vars);
  }

  /**
   * Apply theme vars to document root (for settings/popup pages which are not shadow DOM).
   * Injects a <style id="qm-theme-vars"> into <head>.
   */
  function applyToDocumentRoot(vars) {
    if (!document?.head) return;
    const STYLE_ID = 'qm-theme-vars';
    let styleEl = document.getElementById(STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `:root{${toCSS(vars)}}`;
  }

  /**
   * Remove theme vars from document root.
   */
  function removeFromDocumentRoot() {
    document.getElementById('qm-theme-vars')?.remove();
  }

  /**
   * Apply theme to the settings/popup page from settings.
   * @param {Object} settings
   * @param {string} surface  'popup' | 'settings'
   */
  function applyToPageFromSettings(settings, surface) {
    if (!settings || !settings.theme_enabled) {
      removeFromDocumentRoot();
      return;
    }

    let presetName, customOverrides;

    if (settings.theme_scope === 'per_surface') {
      const surfaceConf = settings.theme_surfaces?.[surface] || {};
      presetName = surfaceConf.preset || 'default';
      customOverrides = surfaceConf.custom || {};
    } else {
      presetName = settings.theme_global_preset || 'default';
      customOverrides = settings.theme_global_custom || {};
    }

    const vars = generateVars(presetName, customOverrides);
    applyToDocumentRoot(vars);
  }

  /* ── Chameleon mode ───────────────────────────────────────────── */

  /**
   * Detect page colors near a given position and generate an adaptive theme.
   *
   * Samples DOM elements around (x, y) to determine the underlying page color.
   * Produces a theme that fits the page context:
   *   - Dark page → dark variant
   *   - Light page → light/default variant
   *   - Medium luminance → picks based on exact brightness
   *
   * Does NOT continuously poll. Called once per window open event.
   *
   * @param {number} x  viewport X coordinate near the widget
   * @param {number} y  viewport Y coordinate near the widget
   * @param {string} strength  'soft' | 'medium' | 'strong'
   * @returns {Object|null}  vars object or null if detection fails
   */
  function detectChameleon(x, y, strength) {
    try {
      // Sample 5 points around the target area
      const samplePoints = [
        [x, y],
        [Math.max(0, x - 60), y],
        [Math.min(window.innerWidth - 1, x + 60), y],
        [x, Math.max(0, y - 40)],
        [x, Math.min(window.innerHeight - 1, y + 40)],
      ];

      let totalR = 0, totalG = 0, totalB = 0, count = 0;

      for (const [px, py] of samplePoints) {
        const elements = document.elementsFromPoint(px, py);
        for (const el of elements) {
          // Skip our own UI elements
          if (el.getAttribute?.('data-quizmind-ui')) continue;
          if (el.tagName === 'HTML' || el.tagName === 'BODY') continue;

          const computed = getComputedStyle(el);
          const bgColor = computed.backgroundColor;

          if (!bgColor || bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent') continue;

          const m = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (!m) continue;

          totalR += parseInt(m[1], 10);
          totalG += parseInt(m[2], 10);
          totalB += parseInt(m[3], 10);
          count++;
          break; // one element per sample point is enough
        }
      }

      // Fallback: sample body and html
      if (count === 0) {
        for (const el of [document.body, document.documentElement]) {
          if (!el) continue;
          const bg = getComputedStyle(el).backgroundColor;
          const m = bg?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (m && parseInt(m[4] || 1, 10) > 0) {
            totalR += parseInt(m[1], 10);
            totalG += parseInt(m[2], 10);
            totalB += parseInt(m[3], 10);
            count++;
            break;
          }
        }
      }

      if (count === 0) return null;

      const avgR = Math.round(totalR / count);
      const avgG = Math.round(totalG / count);
      const avgB = Math.round(totalB / count);

      // Perceived luminance (WCAG formula)
      const luminance = (0.299 * avgR + 0.587 * avgG + 0.114 * avgB) / 255;
      const isDark = luminance < 0.45;

      // Strength adjusts blend amount
      const blendWeight = { soft: 0.05, medium: 0.12, strong: 0.22 }[strength] || 0.12;

      if (isDark) {
        // Dark page — base on dark preset, tint surface with page color
        const baseVars = { ...PRESETS.dark.vars };

        if (strength !== 'soft') {
          // Derive a subtle surface tint from the page color
          const tintR = Math.round(Math.min(255, 30 + avgR * blendWeight));
          const tintG = Math.round(Math.min(255, 41 + avgG * blendWeight));
          const tintB = Math.round(Math.min(255, 59 + avgB * blendWeight));
          baseVars['--qm-surface'] = `rgba(${tintR},${tintG},${tintB},0.95)`;
          baseVars['--qm-header-bg'] = `rgba(${Math.max(0, tintR - 8)},${Math.max(0, tintG - 8)},${Math.max(0, tintB - 8)},0.97)`;
        }

        return baseVars;
      } else {
        // Light page — base on default or light preset
        const basePreset = luminance > 0.85 ? PRESETS['default'] : PRESETS['light'];
        const baseVars = { ...basePreset.vars };

        if (strength !== 'soft') {
          // Slightly tint surface with page color to blend in
          const tintR = Math.round(Math.min(255, 255 * (1 - blendWeight) + avgR * blendWeight));
          const tintG = Math.round(Math.min(255, 255 * (1 - blendWeight) + avgG * blendWeight));
          const tintB = Math.round(Math.min(255, 255 * (1 - blendWeight) + avgB * blendWeight));
          baseVars['--qm-surface'] = `rgba(${tintR},${tintG},${tintB},0.88)`;
          baseVars['--qm-bg'] = `rgb(${Math.round(avgR * 0.97 + 7)},${Math.round(avgG * 0.97 + 7)},${Math.round(avgB * 0.97 + 7)})`;
        }

        return baseVars;
      }
    } catch {
      return null;
    }
  }

  /* ── Public API ───────────────────────────────────────────────── */

  globalThis.TAThemeEngine = {
    TOKEN_KEYS,
    TOKEN_LABELS,
    COLOR_TOKEN_KEYS,
    PRESETS,
    PRESET_NAMES,
    getPreset,
    generateVars,
    toCSS,
    applyToShadowRoot,
    removeFromShadowRoot,
    applyFromSettings,
    applyToDocumentRoot,
    removeFromDocumentRoot,
    applyToPageFromSettings,
    detectChameleon,
  };
})();
