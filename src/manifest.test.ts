import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.join(repoRoot, 'Chrome Extension');
const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
const packageMetadata = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
const backgroundScript = await readFile(path.join(extensionDir, 'background.js'), 'utf8');

test('replacement package version is synchronized and newer than the rejected draft', () => {
  assert.equal(manifest.version, packageMetadata.version);
  assert.notEqual(manifest.version, '1.1.0');
  assert.notEqual(manifest.version, '1.1.1');
  assert.notEqual(manifest.version, '1.1.2');
});

test('extension uses the requested Web Store display name', () => {
  assert.equal(manifest.name, 'p agent extension');
  assert.doesNotMatch(`${manifest.name} ${manifest.description}`, /\b(?:Google|Chrome)\b/i);
});

test('manifest requests only permissions exercised by the extension runtime', () => {
  assert.deepEqual(manifest.permissions, [
    'tabs',
    'debugger',
    'tabGroups',
    'alarms',
    'storage',
    'nativeMessaging',
  ]);
});

test('content script host access is explicit and its packaged files exist', async () => {
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['<all_urls>'],
    css: ['content.css'],
    js: ['content.js'],
    all_frames: true,
  }]);
  const [cssStat, jsStat] = await Promise.all([
    stat(path.join(extensionDir, 'content.css')),
    stat(path.join(extensionDir, 'content.js')),
  ]);
  assert.ok(cssStat.size > 500, 'content.css must not be empty');
  assert.ok(jsStat.size > 500, 'content.js must not be empty');
});

test('manifest declares valid background service worker and file is non-empty', async () => {
  assert.equal(manifest.background?.service_worker, 'background.js');
  const bgStat = await stat(path.join(extensionDir, manifest.background.service_worker));
  assert.ok(bgStat.size > 1000, 'background.js must not be empty');
});

test('all icons declared in manifest exist and are non-empty', async () => {
  assert.deepEqual(Object.keys(manifest.icons || {}).sort(), ['128', '16', '48']);
  for (const [size, relPath] of Object.entries(manifest.icons)) {
    const iconStat = await stat(path.join(extensionDir, relPath as string));
    assert.ok(iconStat.size > 100, `icon${size} must be a valid file`);
  }
});

test('background contains no cookie actions without the cookies permission', () => {
  assert.equal(manifest.permissions.includes('cookies'), false);
  assert.doesNotMatch(backgroundScript, /chrome\.cookies\b/);
  assert.doesNotMatch(backgroundScript, /getAllCookies|setCookie|removeCookie/);
});

test('manifest specifies homepage URL pointing to GitHub repository', () => {
  assert.equal(manifest.homepage_url, 'https://github.com/dst0/chrome-controller');
});

test('manifest action defines popup, packaged assets exist, and popup.html is valid', async () => {
  assert.deepEqual(manifest.action, {
    default_title: 'p agent extension',
    default_popup: 'popup.html',
  });
  const [htmlStat, cssStat, jsStat] = await Promise.all([
    stat(path.join(extensionDir, 'popup.html')),
    stat(path.join(extensionDir, 'popup.css')),
    stat(path.join(extensionDir, 'popup.js')),
  ]);
  assert.ok(htmlStat.size > 200, 'popup.html must not be empty');
  assert.ok(cssStat.size > 200, 'popup.css must not be empty');
  assert.ok(jsStat.size > 200, 'popup.js must not be empty');

  const popupHtml = await readFile(path.join(extensionDir, 'popup.html'), 'utf8');
  assert.match(popupHtml, /<link[^>]+href=["']popup\.css["']/);
  assert.match(popupHtml, /<script[^>]+src=["']popup\.js["']/);
  assert.match(popupHtml, /<img[^>]+src=["']icon48\.png["']/);
  assert.match(popupHtml, /https:\/\/github\.com\/dst0\/chrome-controller/);

  // Invariant: popup.html badge must match manifest.version
  assert.match(popupHtml, new RegExp(`v${manifest.version}`));

  // Invariant: MV3 CSP compliance - no inline scripts or inline event handlers
  assert.doesNotMatch(popupHtml, /<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/i);
  assert.doesNotMatch(popupHtml, /\son\w+\s*=/i, 'popup.html must not contain inline event handlers');
});

test('popup.html contains all element IDs required by popup.js', async () => {
  const popupHtml = await readFile(path.join(extensionDir, 'popup.html'), 'utf8');
  const requiredIds = [
    'status-badge',
    'status-text',
    'extension-id',
    'setup-command',
    'copy-id-btn',
    'copy-cmd-btn',
    'btn-github-doc',
    'btn-webstore-link',
  ];
  for (const id of requiredIds) {
    assert.match(popupHtml, new RegExp(`id=["']${id}["']`), `missing element id "${id}" in popup.html`);
  }
});

test('background script implements getConnectionState message handler for popup', () => {
  assert.match(backgroundScript, /request\.action\s*===\s*['"]getConnectionState['"]/);
  assert.match(backgroundScript, /nativeConnected:\s*Boolean\(nativePort\)/);
  assert.match(backgroundScript, /wsConnected:\s*Boolean\(/);
});

test('relay credentials are paired at runtime and are not hard-coded in the extension', () => {
  assert.doesNotMatch(backgroundScript, /const\s+(?:DEFAULT_)?API_KEY\s*=/);
  assert.doesNotMatch(backgroundScript, /ws:\/\/[^'"`\n]*\?key=[A-Za-z0-9_-]{16,}/);
  assert.match(backgroundScript, /\?key=\$\{encodeURIComponent\(relayConfig\.apiKey\)\}/);
  assert.match(backgroundScript, /getRelayConfig/);
  assert.match(backgroundScript, /chrome\.storage\.session/);
});

test('popup.js has valid JavaScript syntax', async () => {
  const popupJs = await readFile(path.join(extensionDir, 'popup.js'), 'utf8');
  assert.doesNotThrow(() => {
    new Function(popupJs); // parses syntax without executing
  }, 'popup.js contains syntax errors');
});
