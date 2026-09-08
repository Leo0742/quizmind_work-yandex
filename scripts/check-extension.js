const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

check(manifest.manifest_version === 3, 'manifest_version must be 3');
check(manifest.name === 'QuizMind Yandex', 'extension name must be QuizMind Yandex');
check(/^\d+\.\d+\.\d+$/.test(manifest.version), 'manifest version must be semver-like');
check(Array.isArray(manifest.host_permissions), 'host_permissions must be an array');
check(manifest.host_permissions?.includes('<all_urls>'), '<all_urls> is required by Chrome captureVisibleTab for automatic visual-question capture');
check(manifest.host_permissions?.includes('https://forms.yandex.ru/*'), 'Yandex Forms host permission is required');
check(manifest.host_permissions?.includes('https://routerai.ru/*'), 'RouterAI host permission is required');
check((manifest.content_scripts || []).every((entry) => (entry.matches || []).every((match) => match === 'https://forms.yandex.ru/*')), 'content scripts must remain restricted to Yandex Forms');

const referenced = [
  manifest.background?.service_worker,
  manifest.options_page,
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon || {}),
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
].filter(Boolean);
for (const relative of referenced) check(fs.existsSync(path.join(root, relative)), `manifest references missing file: ${relative}`);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.git', 'coverage'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(root);
for (const file of files.filter((name) => name.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  check(result.status === 0, `JavaScript syntax failed: ${path.relative(root, file)}\n${result.stderr.trim()}`);
}

const textFiles = files.filter((file) => /\.(?:js|json|html|md|css)$/i.test(file));
for (const file of textFiles) {
  const body = fs.readFileSync(file, 'utf8');
  check(!/ssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/]{30,}/.test(body), `public/private SSH material found: ${path.relative(root, file)}`);
  check(!/-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----/.test(body), `private key found: ${path.relative(root, file)}`);
  check(!/sk-[A-Za-z0-9_-]{20,}/.test(body), `API-key-like token found: ${path.relative(root, file)}`);
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log(`Extension checks passed (${referenced.length} manifest files, ${files.filter((name) => name.endsWith('.js')).length} JavaScript files).`);
