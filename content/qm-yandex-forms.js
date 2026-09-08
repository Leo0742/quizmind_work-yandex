/**
 * QuizMind Yandex — semantic Yandex Forms DOM adapter.
 *
 * This file intentionally uses stable class names, native control types and
 * accessibility attributes. Generated asset hashes, React internals, numeric
 * question ids and input values are never used as identifiers.
 */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.__QM = root.__QM || {};
    root.__QM.yandexForms = api;
  }
})(typeof window !== 'undefined' ? window : null, () => {
  'use strict';

  const QUESTION_SELECTOR = '.QuestionMarkup.Question';
  const LABEL_SELECTOR = '.QuestionLabel-Text';
  const UI_EXCLUDE_SELECTOR = '[data-quizmind-ui],.ta-helper-shadow-host,.quizmind-settings-shadow-host,.quizmind-multi-shadow-host';
  const TEXT_CONTROL_SELECTOR = [
    'textarea',
    'input[type="number"]',
    'input[inputmode="numeric"]',
    'input[inputmode="decimal"]',
    'input[type="text"]',
    'input:not([type])',
  ].join(',');

  function normalizeText(value = '') {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isYandexFormsPage(locationLike, documentLike) {
    const hostname = String(locationLike?.hostname || '').toLowerCase();
    if (hostname !== 'forms.yandex.ru') return false;
    return Boolean(documentLike?.querySelector?.('form.SurveyPage, .SurveyPage-Content, .QuestionMarkup.Question'));
  }

  function hasExplicitlyHiddenAncestor(element) {
    let node = element;
    while (node?.nodeType === 1) {
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return true;
      const inline = node.style;
      if (inline?.display === 'none' || inline?.visibility === 'hidden') return true;
      node = node.parentElement;
    }
    return false;
  }

  function isVisible(element) {
    if (!element || element.nodeType !== 1 || !element.isConnected) return false;
    if (element.closest?.(UI_EXCLUDE_SELECTOR) || hasExplicitlyHiddenAncestor(element)) return false;
    const view = element.ownerDocument?.defaultView;
    const style = view?.getComputedStyle?.(element);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    if (style?.opacity === '0' && style?.pointerEvents === 'none') return false;
    const rect = element.getBoundingClientRect?.();
    if (rect && (rect.width > 0 || rect.height > 0)) return true;
    // Layout-less DOM implementations (including unit-test fixtures) return
    // zero rectangles. Explicit hidden state above remains authoritative.
    return /jsdom/i.test(String(view?.navigator?.userAgent || ''));
  }

  function findQuestionRoots(documentLike) {
    if (!documentLike?.querySelectorAll) return [];
    return [...documentLike.querySelectorAll(QUESTION_SELECTOR)].filter(isAnswerableQuestion);
  }

  function closestQuestion(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const root = element?.closest?.(QUESTION_SELECTOR) || null;
    return root && isAnswerableQuestion(root) ? root : null;
  }

  function getQuestionLabel(root) {
    return normalizeText(root?.querySelector?.(LABEL_SELECTOR)?.textContent || '');
  }

  function getNativeControls(root) {
    if (!root?.querySelectorAll) return [];
    return [...root.querySelectorAll(`input[type="radio"],input[type="checkbox"],${TEXT_CONTROL_SELECTOR},select`)]
      .filter((control) => isVisible(control) && !control.disabled);
  }

  function getCombobox(root) {
    if (!root?.querySelector) return null;
    if (root.matches?.('.DateQuestion,.TimeQuestion,.DateTimeQuestion')) return null;
    const control = root.querySelector('[role="combobox"]');
    return control && isVisible(control) && control.getAttribute('aria-disabled') !== 'true' ? control : null;
  }

  function isAnswerableQuestion(root) {
    if (!root?.matches?.(QUESTION_SELECTOR) || !isVisible(root)) return false;
    if (!getQuestionLabel(root)) return false;
    if (root.matches('.MatrixQuestion') && !root.querySelector('input,textarea,select,[role="combobox"]')) return false;
    if (root.matches('.DateQuestion,.TimeQuestion,.DateTimeQuestion')) return false;
    return getNativeControls(root).length > 0 || Boolean(getCombobox(root));
  }

  function optionTextFromControl(control) {
    const label = control?.closest?.('label');
    const host = label || control?.closest?.('.RadioQuestion-Option,.CheckboxQuestion-Option,.OptionContent');
    const semantic = host?.querySelector?.('.OptionContent-Text');
    const aria = control?.getAttribute?.('aria-label') || host?.getAttribute?.('aria-label') || '';
    return normalizeText(semantic?.textContent || aria || host?.textContent || '');
  }

  function toAlphaLabel(index) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    return index < alphabet.length ? alphabet[index] : `A${index - alphabet.length + 1}`;
  }

  function extractOptions(root) {
    if (!root?.querySelectorAll) return [];
    const controls = [...root.querySelectorAll('input[type="radio"],input[type="checkbox"]')]
      .filter((control) => isVisible(control) && !control.disabled);
    const choices = controls.map((control, index) => {
      const host = control.closest('label,.RadioQuestion-Option,.CheckboxQuestion-Option,.OptionContent') || control.parentElement;
      const image = host?.querySelector?.('img.OptionContent-Image') || null;
      return {
        key: `option-${index}`,
        label: toAlphaLabel(index),
        text: optionTextFromControl(control) || `Option ${toAlphaLabel(index)}`,
        control,
        kind: control.type,
        image,
        hasImage: Boolean(image),
      };
    });
    for (const select of [...root.querySelectorAll('select')].filter((control) => isVisible(control) && !control.disabled)) {
      for (const nativeOption of [...select.options]) {
        const text = normalizeText(nativeOption.textContent || nativeOption.label || '');
        if (!text || nativeOption.disabled) continue;
        choices.push({
          key: `select-${choices.length}`,
          label: toAlphaLabel(choices.length),
          text,
          value: nativeOption.value,
          control: select,
          kind: 'select-option',
          image: null,
          hasImage: false,
        });
      }
    }
    return choices;
  }

  function resolveControlledListbox(control) {
    const doc = control?.ownerDocument;
    if (!doc) return null;
    const controlledId = control.getAttribute('aria-controls') || control.getAttribute('aria-owns');
    if (controlledId) {
      const css = doc.defaultView?.CSS || globalThis.CSS;
      const escaped = css?.escape ? css.escape(controlledId) : controlledId.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      const direct = doc.querySelector(`#${escaped}`);
      if (direct) return direct;
    }
    return doc.querySelector('[role="listbox"]');
  }

  function getVisibleComboboxOptions(control) {
    const listbox = resolveControlledListbox(control);
    if (!listbox || !isVisible(listbox)) return [];
    return [...listbox.querySelectorAll('[role="option"],.g-select-list__option,.g-menu__item')]
      .filter(isVisible)
      .map((element, index) => ({
        key: `combobox-${index}`,
        label: toAlphaLabel(index),
        text: normalizeText(element.textContent || element.getAttribute('aria-label') || ''),
        control,
        optionElement: element,
        kind: 'combobox-option',
      }))
      .filter((option) => option.text);
  }

  function detectType(root, options = extractOptions(root)) {
    if (options.some((option) => option.kind === 'radio')) return 'single_choice';
    if (options.some((option) => option.kind === 'checkbox')) return 'multi_choice';
    if (root?.querySelector?.('select') || getCombobox(root)) return 'select';
    if (root?.querySelector?.('textarea')) return 'long_text';
    if (root?.querySelector?.('input[type="number"],input[inputmode="numeric"],input[inputmode="decimal"]')) return 'numeric';
    if (root?.querySelector?.(TEXT_CONTROL_SELECTOR)) return 'text';
    return 'unsupported';
  }

  function getImages(root) {
    if (!root?.querySelectorAll) return [];
    return [...root.querySelectorAll('img.QuestionLayout-Image,img.OptionContent-Image')]
      .filter((image) => {
        if (!image.isConnected || image.hidden || image.closest?.(UI_EXCLUDE_SELECTOR)) return false;
        const view = image.ownerDocument?.defaultView;
        const style = view?.getComputedStyle?.(image);
        if (style?.display === 'none' || style?.visibility === 'hidden') return false;
        const rect = image.getBoundingClientRect?.();
        if (rect && (rect.width > 0 || rect.height > 0)) return true;
        // Empty-alt Yandex images can live below aria-hidden wrappers even though
        // their pixels are meaningful. In layout-less fixtures, explicit CSS and
        // hidden attributes above are the only available visibility evidence.
        return /jsdom/i.test(String(view?.navigator?.userAgent || ''));
      })
      .map((image) => ({
        element: image,
        role: image.matches('.OptionContent-Image') ? 'option' : 'question',
        alt: normalizeText(image.alt || image.title || ''),
        src: String(image.currentSrc || image.getAttribute('src') || ''),
      }));
  }

  function getPrimaryTextControl(root) {
    return getNativeControls(root).find((control) => control.matches?.(TEXT_CONTROL_SELECTOR)) || null;
  }

  function extractQuestion(root) {
    if (!isAnswerableQuestion(root)) return null;
    const prompt = getQuestionLabel(root);
    const options = extractOptions(root);
    const type = detectType(root, options);
    if (type === 'unsupported') return null;
    const images = getImages(root);
    const textControl = getPrimaryTextControl(root);
    const combobox = getCombobox(root);
    const fieldSignature = [
      ...options.map((option) => `${option.kind}:${option.text}:${option.hasImage ? 'image' : 'text'}`),
      textControl ? `${textControl.tagName}:${textControl.type || ''}:${textControl.inputMode || ''}` : '',
      combobox ? `combobox:${combobox.getAttribute('aria-controls') || ''}` : '',
      ...images.map((image) => `${image.role}:${image.src.split(/[/?#]/).filter(Boolean).pop() || 'image'}`),
    ].filter(Boolean).join('|');
    return {
      container: root,
      prompt,
      options,
      type,
      instructionText: '',
      tableText: '',
      images: images.map((image) => image.alt).filter(Boolean),
      visualImages: images,
      hasVisual: images.length > 0,
      selectRows: [],
      orderItems: [],
      clozeSubQuestions: [],
      textControl,
      combobox,
      fieldSignature,
      platform: 'yandex_forms',
    };
  }

  function buildStructuredPrompt(question) {
    const lines = [
      'QUESTION:',
      normalizeText(question?.prompt || ''),
      '',
      'TYPE:',
      String(question?.type || 'unsupported'),
    ];
    if (question?.options?.length) {
      lines.push('', 'OPTIONS:');
      for (const option of question.options) {
        lines.push(`${option.label}) ${option.text}${option.hasImage ? ' [image option]' : ''}`);
      }
    }
    if (question?.hasVisual) {
      lines.push('', 'VISUAL_CONTEXT:', 'A screenshot of this complete question block is attached; option labels follow current visible DOM order.');
    }
    lines.push('', 'RESPONSE_FORMAT:');
    if (question?.type === 'multi_choice') lines.push('Return labels separated by commas, for example A,C.');
    else if (question?.type === 'single_choice' || question?.type === 'select') lines.push('Return exactly one option label, for example B.');
    else if (question?.type === 'numeric') lines.push('Return only the number.');
    else lines.push('Return only the exact field value.');
    return lines.join('\n');
  }

  function waitForComboboxOptions(control, timeoutMs = 1600) {
    const immediate = getVisibleComboboxOptions(control);
    if (immediate.length) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const doc = control?.ownerDocument;
      const Observer = doc?.defaultView?.MutationObserver || globalThis.MutationObserver;
      if (!doc?.documentElement || typeof Observer !== 'function') { resolve([]); return; }
      let done = false;
      const finish = (options) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(options);
      };
      const observer = new Observer(() => {
        const options = getVisibleComboboxOptions(control);
        if (options.length) finish(options);
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'hidden', 'style', 'class'] });
      const timer = setTimeout(() => finish(getVisibleComboboxOptions(control)), timeoutMs);
    });
  }

  async function applyComboboxOption(control, token, pickOption) {
    if (!control?.isConnected || typeof pickOption !== 'function') return { applied:false, reason:'no-combobox' };
    if (control.getAttribute('aria-expanded') !== 'true') control.click();
    const options = await waitForComboboxOptions(control);
    const best = pickOption(options, token, 0.65);
    if (!best?.opt?.optionElement) return { applied:false, reason:'combobox-low-confidence' };
    best.opt.optionElement.click();
    await Promise.resolve();
    const visibleValue = normalizeText(control.value || control.textContent || control.getAttribute('aria-label') || '');
    const selected = best.opt.optionElement.getAttribute('aria-selected') === 'true';
    const verified = selected || visibleValue.includes(normalizeText(best.opt.text));
    return verified
      ? { applied:true, reason:'select' }
      : { applied:false, reason:'combobox-verify-failed' };
  }

  function resolveQuestion({ selection, activeElement, hoveredQuestion } = {}) {
    if (selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      const selected = closestQuestion(range.commonAncestorContainer);
      if (selected) return extractQuestion(selected);
    }
    const focused = closestQuestion(activeElement);
    if (focused) return extractQuestion(focused);
    if (hoveredQuestion?.container?.isConnected && isAnswerableQuestion(hoveredQuestion.container)) {
      return extractQuestion(hoveredQuestion.container);
    }
    const doc = activeElement?.ownerDocument || selection?.anchorNode?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const visible = findQuestionRoots(doc).filter((root) => {
      const rect = root.getBoundingClientRect?.();
      const view = doc?.defaultView;
      if (!rect || /jsdom/i.test(String(view?.navigator?.userAgent || ''))) return true;
      return rect.bottom > 0 && rect.top < (view?.innerHeight || 0);
    });
    return visible.length === 1 ? extractQuestion(visible[0]) : null;
  }

  function createSelectionSnapshot(selection, { minLength = 2, url = '' } = {}) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const selectedText = normalizeText(selection.toString());
    if (selectedText.length < minLength) return null;
    let range;
    try { range = selection.getRangeAt(0).cloneRange(); }
    catch { return null; }
    const questionRoot = closestQuestion(range.commonAncestorContainer);
    const question = questionRoot ? extractQuestion(questionRoot) : null;
    const common = range.commonAncestorContainer;
    const element = common?.nodeType === 1 ? common : common?.parentElement;
    const full = String(element?.textContent || '');
    const rawSelected = String(selection.toString() || '').trim();
    const selectedIndex = full.indexOf(rawSelected);
    const before = selectedIndex >= 0
      ? normalizeText(full.slice(Math.max(0, selectedIndex - 200), selectedIndex))
      : '';
    const after = selectedIndex >= 0
      ? normalizeText(full.slice(selectedIndex + rawSelected.length, selectedIndex + rawSelected.length + 200))
      : '';
    return {
      selectedText,
      range,
      questionRoot,
      question,
      before,
      after,
      url,
      timestamp: Date.now(),
    };
  }

  return {
    QUESTION_SELECTOR,
    LABEL_SELECTOR,
    normalizeText,
    isVisible,
    isYandexFormsPage,
    isAnswerableQuestion,
    findQuestionRoots,
    closestQuestion,
    getQuestionLabel,
    extractOptions,
    detectType,
    getImages,
    getCombobox,
    getVisibleComboboxOptions,
    extractQuestion,
    buildStructuredPrompt,
    applyComboboxOption,
    resolveQuestion,
    createSelectionSnapshot,
  };
});
