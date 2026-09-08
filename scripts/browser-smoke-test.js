const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const extensionPath = path.resolve(__dirname, '..');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const formA = 'https://forms.yandex.ru/u/6a0af6ad068ff0002131f88a/';
const formB = 'https://forms.yandex.ru/u/6703ac9d505690857efe68ec/';

async function extensionOperation(worker, page, operation) {
  return worker.evaluate(async ({ url, operation }) => {
    const tabs = await chrome.tabs.query({ url: `${new URL(url).origin}/*` });
    const tab = tabs.find((candidate) => candidate.url === url) || tabs[0];
    if (!tab?.id) return null;
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId:tab.id },
      args: [operation],
      func: (name) => {
        const adapter = globalThis.__QM?.yandexForms;
        if (!adapter) return { ready:false };
        if (name === 'inspect') {
          return {
            ready:true,
            questions:adapter.findQuestionRoots(document).map((root) => {
              const question = adapter.extractQuestion(root);
              return {
                prompt:question.prompt,
                type:question.type,
                options:question.options.map((option) => option.text),
                hasVisual:question.hasVisual,
                questionImages:question.visualImages.filter((image) => image.role === 'question').length,
                optionImages:question.visualImages.filter((image) => image.role === 'option').length,
              };
            }),
          };
        }
        return { ready:true };
      },
    });
    return execution?.result || null;
  }, { url:page.url(), operation });
}

async function waitForAdapter(worker, page) {
  await page.waitForSelector('.QuestionMarkup.Question', { timeout: 30_000 });
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const status = await extensionOperation(worker, page, 'status').catch(() => null);
    if (status?.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Yandex adapter did not initialize in the extension isolated world.');
}

async function inspect(worker, page) {
  const result = await extensionOperation(worker, page, 'inspect');
  assert.equal(result?.ready, true);
  return result.questions;
}

async function waitForVisualExtraction(worker, page) {
  await page.waitForFunction(() => [...document.querySelectorAll('img.QuestionLayout-Image,img.OptionContent-Image')]
    .some((image) => image.getBoundingClientRect().width > 0 && image.getBoundingClientRect().height > 0), { timeout:15_000 });
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const questions = await inspect(worker, page);
    if (questions.some((question) => question.hasVisual)) return questions;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Rendered Yandex images were not classified as visual question content.');
}

async function readTestStat(worker, key) {
  return worker.evaluate((name) => Number(globalThis.__QM_TEST_STATS?.[name] || 0), key);
}

async function waitForTestStat(worker, key, previous, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await readTestStat(worker, key);
    if (current > previous) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for test stat ${key} to advance.`);
}

async function openExtensionPage(page, url, expectedTitle) {
  const session = await page.createCDPSession();
  await session.send('Page.navigate', { url });
  await page.waitForFunction((title) => document.title.includes(title), { timeout:15_000 }, expectedTitle);
}

async function main() {
  const fatal = [];
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    pipe: true,
    enableExtensions: [extensionPath],
    args: ['--no-first-run', '--no-default-browser-check', '--disable-default-apps'],
  });
  try {
    browser.on('targetcreated', async (target) => {
      if (target.type() !== 'service_worker') return;
      try {
        const worker = await target.worker();
        worker.on('console', (message) => {
          if (message.type() === 'error') fatal.push(`service-worker: ${message.text()}`);
        });
      } catch {}
    });

    const workerTarget = await browser.waitForTarget(
      (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
      { timeout: 20_000 },
    );
    const extensionId = new URL(workerTarget.url()).host;
    const worker = await workerTarget.worker();
    const commandBindings = await worker.evaluate(() => chrome.commands.getAll());
    const questionCommand = commandBindings.find((command) => command.name === 'yandex-question');
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        extension_enabled: true,
        taSettings: {
          test_mode: true,
          quiz_page_scan_enabled: true,
          quiz_auto_apply_enabled: true,
          quiz_show_answer_widget: true,
          multi_check_enabled: false,
          widget_timer_ms: 30_000,
          custom_hotkey_yandex_question: 'Ctrl+Shift+H',
        },
      });
    });

    const popup = await browser.newPage();
    await openExtensionPage(popup, `chrome-extension://${extensionId}/popup.html`, 'QuizMind Yandex');
    assert.equal(await popup.title(), 'QuizMind Yandex');
    assert.equal(await popup.$eval('.brand-edition', (node) => node.textContent.trim()), 'Yandex Forms');
    await popup.close();

    const options = await browser.newPage();
    await openExtensionPage(options, `chrome-extension://${extensionId}/options.html`, 'QuizMind Yandex');
    assert.match(await options.title(), /QuizMind Yandex/);
    assert.equal(await options.$eval('.sidebar-edition', (node) => node.textContent.trim()), 'Yandex Forms');
    await options.close();

    const page = await browser.newPage();
    page.on('pageerror', (error) => fatal.push(`page: ${error.message}`));
    await page.goto(formA, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForAdapter(worker, page);
    const a = await inspect(worker, page);
    assert.equal(a.length, 10);
    assert.equal(a[0].type, 'single_choice');
    assert.equal(a[0].options.length, 4);
    assert.match(a[0].prompt, /третья сторона/i);
    assert.equal(a.some((question) => question.prompt.includes(a[0].options.join(' '))), false);
    await page.waitForFunction(() => {
      const root = [...document.querySelectorAll('.QuestionMarkup.Question')].find((node) => node.querySelector('input[type="radio"]'));
      return root?.querySelectorAll('input[type="radio"]')[1]?.checked === true;
    }, { timeout: 20_000 });

    const selectionResult = await page.evaluate(() => {
      const label = document.querySelector('.QuestionMarkup.RadioQuestion .QuestionLabel-Text');
      const range = document.createRange();
      range.selectNodeContents(label);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return label.textContent.trim();
    });
    assert.ok(selectionResult.length > 5);
    await page.waitForFunction(() => {
      const button = document.querySelector('.ta-helper-selection-button');
      return button && button.style.display !== 'none';
    });
    const selectionRequestsBefore = await readTestStat(worker, 'selection');
    await page.evaluate(() => document.querySelector('.ta-helper-selection-button')?.click());
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await readTestStat(worker, 'selection'), selectionRequestsBefore, 'Synthetic page clicks must not invoke a privileged answer request.');
    await page.click('.ta-helper-selection-button');
    await waitForTestStat(worker, 'selection', selectionRequestsBefore);
    assert.equal(await page.evaluate(() => document.querySelector('.ta-helper-shadow-host')?.shadowRoot), null, 'Sensitive widget shadow root must be closed to the host page.');

    const firstQuestion = '.QuestionMarkup.RadioQuestion';
    await page.$eval(firstQuestion, (root) => root.querySelectorAll('input[type="radio"]')[0].click());
    await page.keyboard.down('Meta');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyH');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Meta');
    await page.waitForFunction((selector) => document.querySelector(selector)?.querySelectorAll('input[type="radio"]')[1]?.checked === true, { timeout:15_000 }, firstQuestion);
    await page.$eval(firstQuestion, (root) => root.querySelectorAll('input[type="radio"]')[0].click());
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyH');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await page.waitForFunction((selector) => document.querySelector(selector)?.querySelectorAll('input[type="radio"]')[1]?.checked === true, { timeout:15_000 }, firstQuestion);

    await page.evaluate(() => {
      const host = document.querySelector('.SurveyPage-Content') || document.querySelector('form.SurveyPage');
      const wrapper = document.createElement('div');
      wrapper.innerHTML = '<div class="QuestionMarkup RadioQuestion Question" id="qm-safe-dynamic"><div class="QuestionLabel-Text">Synthetic dynamic check</div><label class="RadioQuestion-Option"><input type="radio" name="qm-safe"><span class="OptionContent-Text">First</span></label><label class="RadioQuestion-Option"><input type="radio" name="qm-safe"><span class="OptionContent-Text">Second</span></label></div>';
      host.appendChild(wrapper.firstElementChild);
    });
    try {
      await page.waitForFunction(() => document.querySelectorAll('#qm-safe-dynamic input[type="radio"]')[1]?.checked === true, { timeout: 20_000 });
    } catch (error) {
      const dynamicState = await page.evaluate(() => ({
        exists:Boolean(document.querySelector('#qm-safe-dynamic')),
        checked:[...document.querySelectorAll('#qm-safe-dynamic input')].map((input) => input.checked),
        rect:(() => { const rect = document.querySelector('#qm-safe-dynamic')?.getBoundingClientRect(); return rect ? { width:rect.width, height:rect.height } : null; })(),
      }));
      const dynamicQuestions = (await inspect(worker, page)).filter((question) => /Synthetic dynamic/.test(question.prompt));
      const progress = await worker.evaluate(async () => (await chrome.storage.local.get(['qm_scan_progress'])).qm_scan_progress || null);
      throw new Error(`Dynamic question did not auto-apply: ${JSON.stringify({ dynamicState, dynamicQuestions, progress })}; ${error.message}`);
    }

    await page.goto(formB, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForAdapter(worker, page);
    const bFirst = await inspect(worker, page);
    assert.ok(bFirst.some((question) => question.type === 'text'));
    assert.equal(bFirst.some((question) => /дата/i.test(question.prompt)), false);

    let bSecond = [];
    let matrixShells = 0;
    let visualAutoApplied = false;
    const nextButton = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((button) => /^(далее|next)$/i.test(button.textContent.trim())) || null);
    const nextElement = nextButton.asElement();
    if (nextElement) {
      const identity = await page.$('.QuestionMarkup.TextQuestion input');
      if (identity) {
        await identity.click({ clickCount:3 });
        await identity.type('Test User');
      }
      const date = await page.$('input[placeholder="ДД.ММ.ГГГГ"]');
      if (date) {
        await date.click();
        await page.keyboard.down('Meta');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Meta');
        await page.keyboard.press('Backspace');
        // The live Gravity UI date mask inserts separators itself. Supplying
        // literal dots can leave the field in an intermittent invalid state.
        await date.type('01012000', { delay:30 });
      }
      const requiredValues = await page.$$eval('.QuestionMarkup input:not([type="radio"]):not([type="checkbox"])', (inputs) => inputs.map((input) => input.value));
      assert.ok(requiredValues.every((value) => String(value).trim().length > 0));
      await nextElement.click();
      try {
        await page.waitForFunction(() => document.querySelectorAll('.QuestionMarkup.RadioQuestion').length >= 5, { timeout: 30_000 });
      } catch (error) {
        const navigationState = await page.evaluate(() => ({
          questions:document.querySelectorAll('.QuestionMarkup.Question').length,
          radios:document.querySelectorAll('.QuestionMarkup.RadioQuestion').length,
          values:[...document.querySelectorAll('.QuestionMarkup input')].map((input) => ({ type:input.type, value:input.value, invalid:input.getAttribute('aria-invalid') })),
          buttons:[...document.querySelectorAll('button')].map((button) => ({ text:button.textContent.trim(), disabled:button.disabled })),
        }));
        throw new Error(`Form B did not navigate to question page: ${JSON.stringify(navigationState)}; ${error.message}`);
      }
      await page.waitForSelector('.QuestionMarkup.RadioQuestion_withImage', { timeout:15_000 });
      await page.evaluate(() => document.querySelector('.QuestionMarkup.RadioQuestion_withImage')?.scrollIntoView({ block:'center' }));
      await page.waitForSelector('img.QuestionLayout-Image,img.OptionContent-Image', { timeout:15_000 });
      await waitForAdapter(worker, page);
      bSecond = await waitForVisualExtraction(worker, page);
      assert.ok(bSecond.length >= 8);
      assert.ok(bSecond.some((question) => /x²|x³/.test(question.prompt)));
      assert.ok(bSecond.some((question) => question.hasVisual));
      assert.ok(bSecond.some((question) => question.optionImages > 0));
      matrixShells = await page.$$eval('.QuestionMarkup.MatrixQuestion', (nodes) => nodes.length);
      assert.ok(matrixShells >= 1);
      await page.evaluate(() => {
        const visual = document.querySelector('.QuestionMarkup.RadioQuestion_withImage');
        visual.scrollIntoView({ block:'center' });
        const input = visual.querySelector('input[type="radio"]');
        input.focus();
      });
      await page.bringToFront();
      await page.keyboard.down('Meta');
      await page.keyboard.down('Shift');
      await page.keyboard.press('KeyH');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Meta');
      try {
        await page.waitForFunction(() => document.querySelector('.QuestionMarkup.RadioQuestion_withImage')?.querySelectorAll('input[type="radio"]')[1]?.checked === true, { timeout:20_000 });
      } catch (error) {
        const state = await page.evaluate(() => ({
          checked:[...document.querySelector('.QuestionMarkup.RadioQuestion_withImage').querySelectorAll('input[type="radio"]')].map((input) => input.checked),
        }));
        throw new Error(`Visual question did not auto-apply: ${JSON.stringify(state)}; ${error.message}`);
      }
      visualAutoApplied = true;
      assert.equal(await page.$eval('button:last-of-type', (button) => /^(отправить|submit)$/i.test(button.textContent.trim()) && button.matches(':focus')), false);
    }

    assert.deepEqual(fatal.filter((message) => /QuizMind|chrome-extension/i.test(message)), []);
    console.log(JSON.stringify({
      extensionId,
      questionCommand:questionCommand?.shortcut || '(not assigned in the automated Chrome profile)',
      formA: { questions:a.length, firstPrompt:a[0].prompt, firstOptions:a[0].options.length, autoApplied:'B' },
      selectionFind:'trusted Find request completed; cleared-selection snapshot covered by unit test',
      pageIsolation:'closed shadow root and synthetic Find click rejected',
      hotkeys:['Command+Shift+H', 'Ctrl+Shift+H'],
      dynamic:'synthetic question detected and auto-applied',
      formB: {
        firstPage:bFirst,
        navigated:Boolean(nextElement),
        secondPageQuestions:bSecond.length,
        visualQuestions:bSecond.filter((question) => question.hasVisual).length,
        optionImageQuestions:bSecond.filter((question) => question.optionImages > 0).length,
        ignoredMatrixShells:matrixShells,
        visualAutoApplied,
      },
      fatalExtensionErrors:fatal.filter((message) => /QuizMind|chrome-extension/i.test(message)),
      submitted:false,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
