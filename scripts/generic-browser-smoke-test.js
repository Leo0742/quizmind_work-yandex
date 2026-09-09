const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const extensionPath = path.resolve(__dirname, '..');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function startFixtureServer() {
  const html = `<!doctype html>
    <html lang="ru"><head><meta charset="utf-8"><title>Обычный сайт</title></head>
    <body>
      <main>
        <div class="QuestionMarkup RadioQuestion Question" id="generic-question">
          <div class="QuestionLabel-Text">Какой вариант является вторым?</div>
          <label><input type="radio" name="generic"><span class="OptionContent-Text">Первый</span></label>
          <label><input type="radio" name="generic"><span class="OptionContent-Text">Второй</span></label>
        </div>
      </main>
    </body></html>`;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
    response.end(html);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url:`http://127.0.0.1:${address.port}/question` });
    });
  });
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

async function main() {
  const fixture = await startFixtureServer();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    pipe: true,
    enableExtensions: [extensionPath],
    args: ['--no-first-run', '--no-default-browser-check', '--disable-default-apps'],
  });
  try {
    const workerTarget = await browser.waitForTarget(
      (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
      { timeout:20_000 },
    );
    const worker = await workerTarget.worker();
    await worker.evaluate(async () => chrome.storage.local.set({
      extension_enabled:true,
      taSettings:{
        test_mode:true,
        auto_send_screenshot:true,
        quiz_page_scan_enabled:true,
        quiz_auto_apply_enabled:true,
        quiz_show_answer_widget:true,
        multi_check_enabled:false,
        custom_hotkey_screenshot:'Ctrl+Shift+U',
      },
    }));

    const page = await browser.newPage();
    await page.goto(fixture.url, { waitUntil:'domcontentloaded', timeout:15_000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(await page.$$eval('#generic-question input', (inputs) => inputs.map((input) => input.checked)), [false, false], 'Generic pages must never be auto-filled.');

    await page.$eval('.QuestionLabel-Text', (label) => {
      const range = document.createRange();
      range.selectNodeContents(label);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.waitForFunction(() => {
      const button = document.querySelector('.ta-helper-selection-button');
      return button && button.style.display !== 'none';
    }, { timeout:10_000 });

    const selectionBefore = await readTestStat(worker, 'selection');
    await page.click('.ta-helper-selection-button');
    await waitForTestStat(worker, 'selection', selectionBefore);
    assert.deepEqual(await page.$$eval('#generic-question input', (inputs) => inputs.map((input) => input.checked)), [false, false], 'Find may show an answer, but must not change a generic page.');

    const yandexBefore = await readTestStat(worker, 'yandex');
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyH');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await readTestStat(worker, 'yandex'), yandexBefore, 'The Yandex-only question hotkey must stay inactive on generic pages.');

    const screenshotBefore = await readTestStat(worker, 'screenshot');
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyU');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await waitForTestStat(worker, 'screenshot', screenshotBefore);

    console.log(JSON.stringify({
      page:fixture.url,
      selectionFind:'trusted Find request completed',
      screenshot:'trusted screenshot hotkey reached the screenshot flow',
      genericAutoFill:false,
    }, null, 2));
  } finally {
    await browser.close();
    await new Promise((resolve) => fixture.server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
