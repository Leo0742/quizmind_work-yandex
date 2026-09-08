# RouterAI smoke test

Use this helper after switching the extension to RouterAI.

```bash
ROUTERAI_API_KEY="paste_key_here" node scripts/routerai-smoke-test.js
```

Optional model override:

```bash
ROUTERAI_API_KEY="paste_key_here" ROUTERAI_MODEL="openai/gpt-4o" node scripts/routerai-smoke-test.js
```

The script checks:

1. `GET https://routerai.ru/api/v1/models`
2. `POST https://routerai.ru/api/v1/chat/completions`
3. read-only candidate endpoints for balance/key information

The script does not print the full API key. If no balance endpoint is found, keep the extension balance line as unavailable and check balance in RouterAI Billing UI.
