const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const adapterSource = fs.readFileSync(path.join(root, 'content/qm-yandex-forms.js'), 'utf8');
const engineSource = fs.readFileSync(path.join(root, 'content/qm-quiz.js'), 'utf8');
const hotkeys = require('../content/qm-hotkeys.js');
const markdownSource = fs.readFileSync(path.join(root, 'content/qm-markdown.js'), 'utf8');
const loggerSource = fs.readFileSync(path.join(root, 'content/qm-logger.js'), 'utf8');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function boot(name = 'yandex-controls.html') {
  const dom = new JSDOM(fixture(name), {
    url: 'https://forms.yandex.ru/u/synthetic-test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.eval(adapterSource);
  dom.window.eval(engineSource);
  const logs = [];
  dom.window.__QM.quiz.init({
    get extensionEnabled() { return true; },
    get quizScanEnabled() { return true; },
    get quizAutoApplyEnabled() { return true; },
    get quizShowAnswerWidget() { return true; },
    qmLog: (scope, message, data) => logs.push({ scope, message, data }),
    addManagedListener: (...args) => args[0].addEventListener(...args.slice(1)),
    safeSendMessage: async () => ({ ok: true, answer: 'B' }),
    runtimeOk: () => true,
    isDebugEnabled: () => false,
  });
  return { dom, window: dom.window, document: dom.window.document, adapter: dom.window.__QM.yandexForms, quiz: dom.window.__QM.quiz, logs };
}

test('detects only the explicit Yandex Forms host with form DOM', () => {
  const { document, adapter } = boot();
  assert.equal(adapter.isYandexFormsPage({ hostname: 'forms.yandex.ru' }, document), true);
  assert.equal(adapter.isYandexFormsPage({ hostname: 'example.com' }, document), false);
});

test('discovers answerable questions and ignores intro, date, empty matrix, and hidden roots', () => {
  const { adapter, document } = boot();
  const ids = Array.from(adapter.findQuestionRoots(document), (node) => node.id);
  assert.deepEqual(ids, ['radio-question', 'checkbox-question', 'text-question', 'long-question', 'number-question', 'select-question']);
});

test('extracts clean prompt and radio options without using generated values', () => {
  const { adapter, document } = boot();
  const question = adapter.extractQuestion(document.querySelector('#radio-question'));
  assert.equal(question.prompt, 'Сколько будет 2 + 2?');
  assert.equal(question.type, 'single_choice');
  assert.deepEqual(Array.from(question.options, ({ label, text }) => ({ label, text })), [
    { label: 'A', text: '3' }, { label: 'B', text: '4' }, { label: 'C', text: '5' },
  ]);
  assert.doesNotMatch(question.fieldSignature, /generated-/);
});

test('builds a stable structured prompt with response format', () => {
  const { adapter, document } = boot();
  const prompt = adapter.buildStructuredPrompt(adapter.extractQuestion(document.querySelector('#radio-question')));
  assert.match(prompt, /QUESTION:\nСколько будет 2 \+ 2\?/);
  assert.match(prompt, /A\) 3\nB\) 4\nC\) 5/);
  assert.match(prompt, /Return exactly one option label/);
});

test('detects text, long-text, numeric, checkbox, and native select types', () => {
  const { adapter, document } = boot();
  const type = (id) => adapter.extractQuestion(document.querySelector(id)).type;
  assert.equal(type('#checkbox-question'), 'multi_choice');
  assert.equal(type('#text-question'), 'text');
  assert.equal(type('#long-question'), 'long_text');
  assert.equal(type('#number-question'), 'numeric');
  assert.equal(type('#select-question'), 'select');
});

test('extracts native select options and values', () => {
  const { adapter, document } = boot();
  const options = adapter.extractQuestion(document.querySelector('#select-question')).options;
  assert.deepEqual(Array.from(options, ({ text, value }) => ({ text, value })), [
    { text: 'Москва', value: 'msk' }, { text: 'Санкт-Петербург', value: 'spb' },
  ]);
});

test('detects prompt and option images even when alt text is empty', () => {
  const { adapter, document } = boot('yandex-images-dynamic.html');
  const question = adapter.extractQuestion(document.querySelector('#image-question'));
  assert.equal(question.hasVisual, true);
  assert.equal(question.visualImages.length, 3);
  assert.deepEqual(Array.from(question.visualImages, (image) => image.role), ['question', 'option', 'option']);
  assert.equal(question.options[0].hasImage, true);
  assert.match(adapter.buildStructuredPrompt(question), /\[image option\]/);
});

test('question signature changes when visible option text changes', () => {
  const { quiz, document } = boot();
  const rootNode = document.querySelector('#radio-question');
  const before = quiz.getQuestionSignature(quiz.extractQuestionData(rootNode));
  rootNode.querySelectorAll('.OptionContent-Text')[1].textContent = 'четыре';
  const after = quiz.getQuestionSignature(quiz.extractQuestionData(rootNode));
  assert.notEqual(after, before);
});

test('dynamic questions are discovered without reloading', () => {
  const { adapter, document } = boot('yandex-images-dynamic.html');
  const host = document.querySelector('#dynamic-host');
  host.innerHTML = '<div class="QuestionMarkup TextQuestion Question" id="late"><div class="QuestionLabel-Text">Поздний вопрос</div><input></div>';
  assert.equal(adapter.findQuestionRoots(document).some((node) => node.id === 'late'), true);
});

test('radio answer matching accepts label, decorated label, and answer text', async () => {
  for (const answer of ['B', 'B)', '4']) {
    const { quiz, document } = boot();
    const question = quiz.extractQuestionData(document.querySelector('#radio-question'));
    const result = await quiz.applyAnswerToQuestion(question, answer);
    assert.equal(result.applied, true, answer);
    assert.equal(document.querySelectorAll('#radio-question input')[1].checked, true, answer);
  }
});

test('fuzzy answer text is rejected below confidence threshold', async () => {
  const { quiz, document } = boot();
  const question = quiz.extractQuestionData(document.querySelector('#radio-question'));
  const result = await quiz.applyAnswerToQuestion(question, 'совершенно другой ответ');
  assert.equal(result.applied, false);
  assert.equal([...document.querySelectorAll('#radio-question input')].some((input) => input.checked), false);
});

test('multi-choice applies the requested set and clears stale checks', async () => {
  const { quiz, document } = boot();
  const rootNode = document.querySelector('#checkbox-question');
  rootNode.querySelectorAll('input')[2].checked = true;
  const result = await quiz.applyAnswerToQuestion(quiz.extractQuestionData(rootNode), 'A, B');
  assert.equal(result.applied, true);
  assert.deepEqual([...rootNode.querySelectorAll('input')].map((input) => input.checked), [true, true, false]);
});

test('writes and verifies short, long, and numeric answers with input events', async () => {
  const { quiz, document } = boot();
  for (const [id, value] of [['#text-question', 'Иванов'], ['#long-question', 'Потому что 2 + 2 = 4'], ['#number-question', '42']]) {
    const rootNode = document.querySelector(id);
    const field = rootNode.querySelector('input,textarea');
    let inputEvents = 0;
    field.addEventListener('input', () => { inputEvents += 1; });
    const result = await quiz.applyAnswerToQuestion(quiz.extractQuestionData(rootNode), value);
    assert.equal(result.applied, true, id);
    assert.equal(field.value, value, id);
    assert.ok(inputEvents >= 1, id);
  }
});

test('applies a native select answer by visible text', async () => {
  const { quiz, document } = boot();
  const rootNode = document.querySelector('#select-question');
  const result = await quiz.applyAnswerToQuestion(quiz.extractQuestionData(rootNode), 'Санкт-Петербург');
  assert.equal(result.applied, true);
  assert.equal(rootNode.querySelector('select').value, 'spb');
});

test('opens and applies a custom accessible combobox option', async () => {
  const { quiz, document } = boot('yandex-images-dynamic.html');
  const combo = document.querySelector('[role="combobox"]');
  const list = document.querySelector('#color-list');
  combo.addEventListener('click', () => {
    combo.setAttribute('aria-expanded', 'true');
    list.hidden = false;
  });
  for (const option of list.querySelectorAll('[role="option"]')) {
    option.addEventListener('click', () => {
      option.setAttribute('aria-selected', 'true');
      combo.textContent = option.textContent;
      list.hidden = true;
    });
  }
  const question = quiz.extractQuestionData(document.querySelector('#combo-question'));
  const result = await quiz.applyAnswerToQuestion(question, 'Синий');
  assert.equal(result.applied, true);
  assert.equal(combo.textContent, 'Синий');
});

test('resolver honors selection, focus, hover, then unambiguous fallback', () => {
  const { adapter, window, document } = boot();
  const labelText = document.querySelector('#radio-question .QuestionLabel-Text').firstChild;
  const range = document.createRange();
  range.selectNodeContents(labelText);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  assert.equal(adapter.resolveQuestion({ selection, activeElement: document.body }).container.id, 'radio-question');
  selection.removeAllRanges();
  const focused = document.querySelector('#text-question input');
  focused.focus();
  assert.equal(adapter.resolveQuestion({ selection, activeElement: focused }).container.id, 'text-question');
  focused.blur();
  const hovered = adapter.extractQuestion(document.querySelector('#checkbox-question'));
  assert.equal(adapter.resolveQuestion({ selection, activeElement: document.body, hoveredQuestion: hovered }).container.id, 'checkbox-question');
  assert.equal(adapter.resolveQuestion({ selection, activeElement: document.body }), null);
});

test('selection snapshot retains cloned range and nearest question after selection is cleared', () => {
  const { adapter, window, document } = boot();
  const text = document.querySelector('#radio-question .QuestionLabel-Text').firstChild;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 7);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const snapshot = adapter.createSelectionSnapshot(selection, { minLength: 2, url: window.location.href });
  selection.removeAllRanges();
  assert.equal(snapshot.selectedText, 'Сколько');
  assert.equal(snapshot.question.container.id, 'radio-question');
  assert.equal(snapshot.range.toString(), 'Сколько');
});

test('answer application never submits or clicks navigation buttons', async () => {
  const { quiz, window, document } = boot();
  let submissions = 0;
  let submitClicks = 0;
  document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); submissions += 1; });
  document.querySelector('#submit').addEventListener('click', () => { submitClicks += 1; });
  await quiz.applyAnswerToQuestion(quiz.extractQuestionData(document.querySelector('#radio-question')), 'B');
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  assert.equal(submissions, 0);
  assert.equal(submitClicks, 0);
});

test('Yandex question hotkey accepts Command or Ctrl and requires Shift+H', () => {
  assert.equal(hotkeys.match({ key:'h', code:'KeyH', metaKey:true, ctrlKey:false, shiftKey:true, altKey:false }, 'Ctrl+Shift+H'), true);
  assert.equal(hotkeys.match({ key:'H', code:'KeyH', metaKey:false, ctrlKey:true, shiftKey:true, altKey:false }, 'Ctrl+Shift+H'), true);
  assert.equal(hotkeys.match({ key:'h', code:'KeyH', metaKey:false, ctrlKey:false, shiftKey:true, altKey:false }, 'Ctrl+Shift+H'), false);
  assert.equal(hotkeys.match({ key:'h', code:'KeyH', metaKey:true, ctrlKey:false, shiftKey:false, altKey:false }, 'Ctrl+Shift+H'), false);
});

test('selection snapshots can be created repeatedly for different questions', () => {
  const { adapter, window, document } = boot();
  const selection = window.getSelection();
  const capture = (selector) => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(selector));
    selection.removeAllRanges();
    selection.addRange(range);
    return adapter.createSelectionSnapshot(selection, { minLength:2, url:window.location.href });
  };
  const first = capture('#radio-question .QuestionLabel-Text');
  const second = capture('#checkbox-question .QuestionLabel-Text');
  assert.equal(first.question.container.id, 'radio-question');
  assert.equal(second.question.container.id, 'checkbox-question');
  assert.notEqual(first.selectedText, second.selectedText);
});

test('page scan completes the mock request and auto-applies each radio answer', async () => {
  const { dom, quiz, window, document } = boot();
  quiz.scheduleQuizPrefetch(50);
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  const radio = document.querySelectorAll('#radio-question input[type="radio"]');
  assert.equal(radio[1].checked, true);
  quiz.ensureQuizScanObserver(false);
  dom.window.close();
});

test('Markdown and LaTeX rendering escape hostile model HTML', () => {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts:'outside-only' });
  dom.window.eval(markdownSource);
  const render = dom.window.__QM_MARKDOWN.renderMarkdown;
  const ordinary = render('<img src=x onerror="globalThis.pwned=1">');
  const latex = render('$<img src=x onerror="globalThis.pwned=1">$');
  assert.doesNotMatch(ordinary, /<img/i);
  assert.doesNotMatch(latex, /<img/i);
  const host = dom.window.document.createElement('div');
  host.innerHTML = latex;
  assert.equal(host.querySelector('img'), null);
});

test('content diagnostics do not accumulate while logging is disabled', () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url:'https://forms.yandex.ru/u/test/', runScripts:'outside-only' });
  dom.window.chrome = { storage:{ local:{ set:async () => {}, remove:async () => {} } } };
  dom.window.eval(loggerSource);
  dom.window.localStorage.setItem('qm_scan_log', '1');
  dom.window.__QM_LOGGER.qmLog('FLOW', 'private diagnostic', { prompt:'must not persist' });
  assert.equal(dom.window.__QM_DUMP_LOG(), 'Logged 0 entries');
});
