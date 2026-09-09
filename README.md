# QuizMind — universal Find and screenshot branch

Chrome Extension (Manifest V3) for answering selected text and screenshots on ordinary HTTP/HTTPS sites through RouterAI. This branch retains the extended Yandex Forms adapter; the popup and settings page carry a visible **Yandex Forms** badge.

## Supported Yandex Forms controls

- Single choice (`radio`)
- Multiple choice (`checkbox`)
- Short text and numeric fields
- Long text (`textarea`)
- Native and accessible custom select/combobox controls
- Questions with a prompt image or image options

Intro blocks, detached/hidden controls, date/time controls, and empty matrix shells are ignored. Option letters are assigned in current visible DOM order (`A`, `B`, `C`, …); generated React IDs and input values are not used as answer labels.

## How it works

For text questions, the extension extracts the visible question label, control type, and option texts into a structured prompt. For image-bearing questions it captures the whole visible question block, including every option, then sends the crop and structured prompt to the configured vision model.

Answers are only applied when **Quiz auto-apply** is enabled. The extension verifies the resulting control state after a click or input event. It never presses **Next**, **Submit**, or any other form navigation button.

Question targeting uses this order:

1. the question containing the current text selection;
2. the question containing the focused control;
3. the most recently hovered question;
4. a fallback only when exactly one answerable question is visible.

The dedicated hotkey is `Ctrl+Shift+H` by default and can be changed in Settings.

- macOS: `Command+Shift+H`
- Windows/Linux: `Ctrl+Shift+H`

Enable **Quiz Page Scan** in Settings to prepare answers for every currently visible answerable question. Enable **Quiz Auto Apply** separately if those prepared answers should be written into controls. Scanning alone never changes the form.

## Selection workflow

Selecting text on any ordinary HTTP/HTTPS page displays the **Find** button. The selected text, cloned DOM Range, nearest supported question, and short local context are captured before any asynchronous work begins, so clicking the button does not lose the original selection. On non-Yandex sites the result is displayed without scanning or changing page controls.

The screenshot hotkey (`Ctrl+Shift+U`, or `Command+Shift+U` on macOS) also works on ordinary HTTP/HTTPS pages. Depending on Settings, it captures a user-selected region or the visible viewport and sends it to the configured vision model.

## RouterAI and privacy

Requests use the OpenAI-compatible endpoint at `https://routerai.ru/api/v1`. API keys and settings are stored in Chrome extension storage. Selected text, extracted question content, and question screenshots are sent only when an answer is requested. Diagnostic content logs are disabled by default and are not accumulated while disabled; explicitly enabled debug logs may contain truncated question/answer diagnostics but never API keys.

The original free-form screenshot workflow, configurable RouterAI model selection, Multi-Check consensus, on-page chat, answer history, themes, and Course Pack grounding remain available. Course Pack has a dedicated **Use in Yandex Forms answers** switch.

## Public verification forms

- [Mathematics, grade 5](https://forms.yandex.ru/u/6a0af6ad068ff0002131f88a/)
- [Derivative practice test](https://forms.yandex.ru/u/6703ac9d505690857efe68ec/)

Use test mode for verification and do not submit the forms.

## Install locally

1. Run `npm install` and `npm test` (optional but recommended for development).
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this repository directory.
5. Open the extension popup, then Settings, and configure the RouterAI API key and text/vision models.

Content scripts and widget assets are available on ordinary `http://` and `https://` pages; network requests are made only to `https://routerai.ru/*`. Chrome's `captureVisibleTab` API requires either a temporary `activeTab` grant or the `<all_urls>` host capability, so this edition declares `<all_urls>` for screenshot capture. Quiz Page Scan, automatic answer application, the dedicated Yandex hotkey, and automatic visual-question capture remain gated to `forms.yandex.ru`.

## Development checks

```bash
npm test
npm run check
npm run test:browser:generic
```

`npm test` covers extraction, hidden/dynamic questions, image detection, answer matching, controlled application, selection snapshots, and non-submission behavior. `npm run check` validates the manifest, local file references, JavaScript syntax, and host permissions. `npm run test:browser:generic` verifies Find and screenshot triggering on a local non-Yandex page and proves that generic page controls are not auto-filled.

## Architecture

```text
manifest.json
├── background.js                 MV3 service worker and RouterAI routing
├── content/qm-yandex-forms.js    Yandex Forms semantic DOM adapter
├── content/qm-quiz.js            scan, cache, matching, and controlled apply
├── content.js                    on-page UI, selection, hotkeys, capture flow
├── answerEngine.js               text answer pipeline
├── screenshotFlow.js             general screenshot workflow
├── multiCheck.js                 multi-model verification
├── popup.html / popup.js         quick controls
└── options.html / options.js     settings
```

## Known limitations

- Chrome internal pages, the Chrome Web Store, and other browser-protected schemes do not allow extension content-script injection.
- Date/time questions are deliberately unsupported because calendar widgets need a separate semantic adapter.
- A matrix shell without answer controls is ignored. Matrix layouts with stable accessible controls can be added with dedicated fixtures later.
- A question image outside the viewport is not prefetched automatically; an explicit hotkey/request may scroll it into view before capture.
- Quiz Page Scan limits automatic RouterAI work to three concurrent requests and sixty unique question signatures per page lifecycle; disable and re-enable scanning to reset that budget.
- Live model calls require a valid RouterAI key. Test mode returns deterministic mocked answers and is intended for release verification.

## Release safety

The repository contains no API keys, SSH private keys, saved Yandex HTML pages, form answers, or personal form data. Browser verification must stop before form submission.
