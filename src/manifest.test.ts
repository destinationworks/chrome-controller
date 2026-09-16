import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
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
  await Promise.all([
    access(path.join(extensionDir, 'content.css')),
    access(path.join(extensionDir, 'content.js')),
  ]);
});

test('background contains no cookie actions without the cookies permission', () => {
  assert.equal(manifest.permissions.includes('cookies'), false);
  assert.doesNotMatch(backgroundScript, /chrome\.cookies\b/);
  assert.doesNotMatch(backgroundScript, /getAllCookies|setCookie|removeCookie/);
});
