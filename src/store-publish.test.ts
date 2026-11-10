import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseListing, validateListing, HOST_PERMISSION } from '../scripts/store-listing.js';
import {
  credentialsFromEnvironment, fetchAccessToken, fetchStatus, publishItem, publishedVersion, uploadPackage, waitForUpload,
} from '../scripts/store-api.js';
import { buildPackage, isNewerVersion, readZip } from '../scripts/store-package.js';
import {
  closePublisherChrome, consoleFieldPlan, editUrl, openConsoleTab, openSignInChrome, profileInUse, saveDraft, startPublisherChrome, syncFields,
} from '../scripts/store-console.js';
import { parseArgs, runPublish } from '../scripts/store-publish.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realListing = fs.readFileSync(path.join(repoRoot, 'docs', 'chrome-web-store-listing.md'), 'utf8');
const realManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'Chrome Extension', 'manifest.json'), 'utf8'));
const PUBLISHER = '9a5c4d7a-94b2-4dd1-bc8b-676349c60d48';
const ITEM = 'gocbenlgkgeaiifofilndbnaeigpplca';

// A complete listing file with distinct values in every field, so a value routed to the
// wrong console field shows up as a mismatch.
function listingFixture(description = "Fixture description.\n\nWHAT'S NEW IN 2.0.1\n• Fixture notes.") {
  return [
    '# Chrome Web Store Listing Copy',
    `[edit](https://chrome.google.com/webstore/devconsole/${PUBLISHER}/${ITEM}/edit)`,
    '## 1. Summary / Short Description (under 132 characters)', '```text', 'Fixture summary', '```',
    '## 2. Detailed Description (Store Overview)', '```text', description, '```',
    '## 3. Homepage URL Field', '```text', 'https://home.example/repo', '```',
    '## 4. Support URL Field', '```text', 'https://support.example/issues', '```',
    '## 5. Privacy Policy URL Field (Privacy practices tab)', '```text', 'https://privacy.example/policy', '```',
    '## 6. Category and Language', '```text', 'Category: Developer Tools', 'Language: English', 'Mature content: No', '```',
    '## 7. Privacy Practices Tab',
    '### Single purpose description', '```text', 'Fixture purpose.', '```',
    '### Permission justifications', '```text', 'tabs: Tabs reason.', 'storage: Storage reason.', 'Host permission: Host reason.', '```',
    '## Published before', '```text', 'Old description that must never be read.', '```',
    '',
  ].join('\n');
}
const fixtureManifest = { version: '2.0.1', description: 'Fixture summary', permissions: ['tabs', 'storage'], content_scripts: [{ matches: ['<all_urls>'] }] };

// ── Listing file ──────────────────────────────────────────────────────────────

test('every listing field is read from its own section', () => {
  assert.deepEqual(parseListing(listingFixture()), {
    publisherId: PUBLISHER,
    itemId: ITEM,
    summary: 'Fixture summary',
    description: "Fixture description.\n\nWHAT'S NEW IN 2.0.1\n• Fixture notes.",
    homepageUrl: 'https://home.example/repo',
    supportUrl: 'https://support.example/issues',
    privacyPolicyUrl: 'https://privacy.example/policy',
    category: 'Developer Tools',
    language: 'English',
    singlePurpose: 'Fixture purpose.',
    permissionJustifications: [['tabs', 'Tabs reason.'], ['storage', 'Storage reason.'], ['Host permission', 'Host reason.']],
  });
  assert.deepEqual(validateListing(parseListing(listingFixture()), fixtureManifest), []);
});

test('the real listing file parses and matches the manifest it ships with', () => {
  const listing = parseListing(realListing);
  assert.equal(listing.itemId, ITEM);
  assert.equal(listing.publisherId, PUBLISHER);
  assert.ok(!listing.description.includes('cookie-management functionality'), 'the recovered pre-1.3.2 text must not be read as the live description');
  assert.deepEqual(validateListing(listing, realManifest), []);
});

test('headings and longer-fenced examples inside a text block are kept as text', () => {
  const description = "Intro\n## Not a heading\n````text\nnested\n````\nWHAT'S NEW IN 2.0.1\nnotes";
  const wrapped = listingFixture(description).replace('```text\n' + description + '\n```', '`````text\n' + description + '\n`````');
  assert.equal(parseListing(wrapped).description, description);
});

test('a fenced example inside a three-backtick block is refused instead of truncating the description', () => {
  const file = listingFixture("Example config:\n```json\n{}\n```\nWHAT'S NEW IN 2.0.1\nnotes");
  assert.throws(() => parseListing(file), /contains the fence "```json"; wrap it in a longer fence/);
});

test('CRLF line endings parse exactly like LF', () => {
  assert.deepEqual(parseListing(listingFixture().replace(/\n/g, '\r\n')), parseListing(listingFixture()));
});

test('malformed listing files fail with the section they break', () => {
  const file = listingFixture();
  assert.throws(() => parseListing(file.replace('## 4. Support URL Field', '## 4. Support Link')), /no "Support URL" section/);
  assert.throws(() => parseListing(file.replace('## 3. Homepage URL Field\n```text', '## 3. Homepage URL Field\n```')), /"Homepage URL" section has no ```text block/);
  // A lost closing fence swallows the next heading; the parse fails rather than shifting fields.
  assert.throws(() => parseListing(file.replace(/https:\/\/privacy\.example\/policy\n```/, 'https://privacy.example/policy')), /no "Category and Language" section/);
  assert.throws(() => parseListing(file.replace(/Old description that must never be read\.\n```/, 'Old description that must never be read.')), /fence opened on line \d+ that never closes/);
  assert.throws(() => parseListing(file.replace(`devconsole/${PUBLISHER}/`, 'devconsole/')), /edit link/);
  assert.throws(() => parseListing(file.replace('tabs: Tabs reason.', 'tabs Tabs reason.')), /not "name: value"/);
  assert.throws(() => parseListing(file.replace('tabs: Tabs reason.', 'tabs:  ')), /not "name: value"|empty or padded/);
  assert.throws(() => parseListing(file.replace('Category: Developer Tools', 'Category: Developer Tools ')), /empty or padded/);
  assert.throws(() => parseListing(file.replace('storage: Storage reason.', 'tabs: Again.')), /names "tabs" twice/);
});

test('validation rejects console limits, stale release notes and permission drift', () => {
  const listing = parseListing(listingFixture());
  const problems = (change: Record<string, unknown>, manifest: Record<string, unknown> = fixtureManifest) => validateListing({ ...listing, ...change }, manifest).join('\n');
  assert.equal(problems({ summary: 'x'.repeat(132) }, { ...fixtureManifest, description: 'x'.repeat(132) }), '');
  assert.match(problems({ summary: 'x'.repeat(133) }, { ...fixtureManifest, description: 'x'.repeat(133) }), /summary must be 1-132/);
  assert.match(problems({ summary: '' }, { ...fixtureManifest, description: '' }), /summary must be 1-132/);
  assert.match(problems({ summary: 'a\nb' }, { ...fixtureManifest, description: 'a\nb' }), /single line/);
  assert.match(problems({}, { ...fixtureManifest, description: 'Older summary' }), /summary must equal the manifest description/);
  assert.match(problems({ description: listing.description + 'x'.repeat(16_000) }), /at most 16000/);
  assert.match(problems({}, { ...fixtureManifest, version: '9.9.9' }), /must name manifest version 9\.9\.9/);
  assert.match(problems({ description: "WHAT'S NEW IN 2.0.10\nnotes" }), /must name manifest version 2\.0\.1/);
  assert.match(problems({ homepageUrl: 'http://home.example' }), /homepage URL must be one https URL/);
  assert.match(problems({ supportUrl: 'https://a.example https://b.example' }), /support URL must be one https URL/);
  assert.match(problems({ privacyPolicyUrl: '' }), /privacy policy URL/);
  assert.match(problems({ singlePurpose: '  ' }), /single purpose description is empty/);
  assert.match(problems({ category: undefined }), /category is missing/);
  assert.match(problems({ language: undefined }), /language is missing/);
  assert.match(problems({}, { ...fixtureManifest, permissions: ['tabs', 'storage', 'cookies'] }), /no justification for permission "cookies"/);
  assert.match(problems({}, { ...fixtureManifest, permissions: ['tabs'] }), /justification for "storage", which the manifest does not request/);
  assert.match(problems({}, { ...fixtureManifest, content_scripts: [] }), new RegExp(`justification for "${HOST_PERMISSION}"`));
  assert.equal(problems({}, { ...fixtureManifest, content_scripts: [], host_permissions: ['https://*/*'] }), '');
});

// ── Store API ─────────────────────────────────────────────────────────────────

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<{ status?: number; body?: unknown; raw?: string }>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    assert.ok(next, `unexpected request to ${url}`);
    return new Response(next.raw ?? (next.body === undefined ? '' : JSON.stringify(next.body)), { status: next.status ?? 200 });
  };
  return { calls, impl: impl as unknown as typeof fetch };
}
const ids = { publisherId: PUBLISHER, itemId: ITEM };

test('credentials must all be present and name the variables that are missing', () => {
  assert.throws(() => credentialsFromEnvironment({ CWS_CLIENT_ID: 'id' }), /missing: CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN/);
  assert.deepEqual(credentialsFromEnvironment({ CWS_CLIENT_ID: 'i', CWS_CLIENT_SECRET: 's', CWS_REFRESH_TOKEN: 'r' }), { clientId: 'i', clientSecret: 's', refreshToken: 'r' });
});

test('the token refresh posts the refresh grant and its errors never echo the secret', async () => {
  const credentials = { clientId: 'cid', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' };
  const ok = fakeFetch([{ body: { access_token: 'access-1' } }]);
  assert.equal(await fetchAccessToken(credentials, ok.impl), 'access-1');
  assert.equal(ok.calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(ok.calls[0].init.body))), { client_id: 'cid', client_secret: 'synthetic-secret', refresh_token: 'synthetic-refresh', grant_type: 'refresh_token' });

  const denied = fakeFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }]);
  await assert.rejects(fetchAccessToken(credentials, denied.impl), (error: Error) => {
    assert.match(error.message, /HTTP 400: Token has been expired or revoked/);
    assert.ok(!error.message.includes('synthetic'), 'error must not contain credentials');
    return true;
  });
  await assert.rejects(fetchAccessToken(credentials, fakeFetch([{ body: {} }]).impl), /no access_token/);
  await assert.rejects(fetchAccessToken(credentials, fakeFetch([{ raw: '<html>proxy</html>' }]).impl), /not a JSON object/);
});

test('upload, status and publish hit the V2 endpoints with the bearer token', async () => {
  const zip = Buffer.from('PK synthetic zip');
  const api = fakeFetch([
    { body: { uploadState: 'SUCCEEDED', crxVersion: '1.3.2' } },
    { body: { itemId: ITEM, publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.3.0', deployPercentage: 100 }] } } },
    { body: { state: 'PENDING_REVIEW' } },
  ]);
  assert.deepEqual(await uploadPackage({ token: 't', ...ids, zip }, api.impl), { uploadState: 'SUCCEEDED', crxVersion: '1.3.2' });
  assert.equal(publishedVersion(await fetchStatus({ token: 't', ...ids }, api.impl)), '1.3.0');
  assert.deepEqual(await publishItem({ token: 't', ...ids }, api.impl), { state: 'PENDING_REVIEW' });

  const item = `publishers/${PUBLISHER}/items/${ITEM}`;
  assert.deepEqual(api.calls.map((call) => `${call.init.method} ${call.url}`), [
    `POST https://chromewebstore.googleapis.com/upload/v2/${item}:upload`,
    `GET https://chromewebstore.googleapis.com/v2/${item}:fetchStatus`,
    `POST https://chromewebstore.googleapis.com/v2/${item}:publish`,
  ]);
  for (const call of api.calls) assert.equal((call.init.headers as Record<string, string>).authorization, 'Bearer t');
  assert.equal(api.calls[0].init.body, zip);
  assert.deepEqual(JSON.parse(String(api.calls[2].init.body)), { publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true });
});

test('API answers that are errors, unreadable or about another item fail', async () => {
  await assert.rejects(uploadPackage({ token: 't', ...ids, zip: Buffer.alloc(1) }, fakeFetch([{ status: 400, body: { error: { message: 'The version must be greater.' } } }]).impl), /Package upload failed with HTTP 400: The version must be greater/);
  await assert.rejects(fetchStatus({ token: 't', ...ids }, fakeFetch([{ status: 503 }]).impl), /^Error: Status fetch failed with HTTP 503$/);
  await assert.rejects(fetchStatus({ token: 't', ...ids }, fakeFetch([{ raw: 'not json' }]).impl), /not a JSON object/);
  await assert.rejects(fetchStatus({ token: 't', ...ids }, fakeFetch([{ body: {} }]).impl), /answered for item none/);
  await assert.rejects(fetchStatus({ token: 't', ...ids }, fakeFetch([{ body: { itemId: 'other' } }]).impl), /answered for item other/);
  for (const state of ['REJECTED', 'CANCELLED', undefined]) {
    await assert.rejects(publishItem({ token: 't', ...ids }, fakeFetch([{ body: { state } }]).impl), new RegExp(`Publish ended in state ${state ?? 'unknown'}`));
  }
});

test('an upload still processing is polled until it succeeds, fails or runs out of checks', async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const statuses = [{ lastAsyncUploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'SUCCEEDED', submittedItemRevisionStatus: { distributionChannels: [{ crxVersion: '1.0.0' }] } }];
  assert.equal(await waitForUpload({ uploadState: 'IN_PROGRESS' }, async () => statuses.shift()!, { sleep, intervalMs: 5 }), undefined, 'a status response never describes the fresh draft');
  assert.deepEqual(sleeps, [5, 5]);
  assert.equal(await waitForUpload({ uploadState: 'UPLOAD_IN_PROGRESS' }, async () => ({ lastAsyncUploadState: 'SUCCEEDED' }), { sleep }), undefined);
  assert.equal(await waitForUpload({ uploadState: 'SUCCEEDED', crxVersion: '1.3.2' }, async () => assert.fail('no poll needed'), { sleep }), '1.3.2');

  for (const state of ['FAILED', 'NOT_FOUND']) {
    await assert.rejects(waitForUpload({ uploadState: 'IN_PROGRESS' }, async () => ({ lastAsyncUploadState: state }), { sleep }), new RegExp(`ended in state ${state}`));
  }
  let polls = 0;
  await assert.rejects(waitForUpload({ uploadState: 'IN_PROGRESS' }, async () => { polls += 1; return { lastAsyncUploadState: 'IN_PROGRESS' }; }, { sleep, attempts: 3 }), /still processing after 3 status checks/);
  assert.equal(polls, 3);
  await assert.rejects(waitForUpload({ uploadState: 'FAILED' }, async () => assert.fail('no poll'), { sleep }), /ended in state FAILED/);
});

// ── Package ───────────────────────────────────────────────────────────────────

function fixtureRepo(files: Record<string, string | Buffer> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-package-'));
  const run = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-02T03:04:05+00:00', GIT_AUTHOR_DATE: '2020-01-02T03:04:05+00:00' } });
  run('init', '-q');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Test');
  const all: Record<string, string | Buffer> = {
    'Chrome Extension/manifest.json': JSON.stringify({ manifest_version: 3, name: 'fixture', version: '2.0.1' }),
    'Chrome Extension/background.js': 'console.log("bg");\n',
    'Chrome Extension/icons/icon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]),
    'README.md': 'not packaged\n',
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  run('add', '-A');
  run('commit', '-q', '-m', 'fixture');
  return root;
}
function withRepo(files: Record<string, string | Buffer>, work: (root: string, out: string) => void) {
  const root = fixtureRepo(files);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'store-package-out-'));
  try { work(root, out); } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test('the package holds exactly the committed extension files, stamped with the commit time', () => {
  withRepo({ 'Chrome Extension/[odd] name ü.js': 'x;\n' }, (root, out) => {
    const pkg = buildPackage({ repoRoot: root, outDir: out });
    assert.deepEqual(pkg.entries, ['[odd] name ü.js', 'background.js', 'icons/icon.png', 'manifest.json']);
    assert.equal(pkg.version, '2.0.1');
    assert.ok(pkg.bytes.equals(fs.readFileSync(pkg.path)));
    assert.match(path.basename(pkg.path), /^chrome-extension-v2\.0\.1-[0-9a-f]{12}\.zip$/);
    // Entry times come from the commit, not the clock, which is what makes the digest reproducible.
    const files = readZip(pkg.bytes);
    assert.equal(files.length, 4);
    for (const file of files) assert.equal(file.mtime, Date.parse('2020-01-02T03:04:05Z') / 1000, `${file.name} must carry the commit time`);
    assert.equal(files.find((file) => file.name === '[odd] name ü.js')?.data.toString(), 'x;\n');
    assert.equal(buildPackage({ repoRoot: root, outDir: path.join(out, 'again') }).sha256, pkg.sha256);
  });
});

test('attributes that change archived files are caught by the entry checks', () => {
  withRepo({ 'Chrome Extension/.gitattributes': 'dev-only.js export-ignore\n', 'Chrome Extension/dev-only.js': '1;\n' }, (root, out) => {
    assert.throws(() => buildPackage({ repoRoot: root, outDir: out }), /Package entries differ/);
  });
  withRepo({ 'Chrome Extension/.gitattributes': 'a.js text eol=crlf\n', 'Chrome Extension/a.js': 'one\ntwo\n' }, (root, out) => {
    assert.throws(() => buildPackage({ repoRoot: root, outDir: out }), /Package entry a\.js differs from the commit/);
  });
});

test('uncommitted extension changes are refused; changes elsewhere are not', () => {
  withRepo({}, (root, out) => {
    fs.writeFileSync(path.join(root, 'README.md'), 'edited\n');
    assert.equal(buildPackage({ repoRoot: root, outDir: out }).version, '2.0.1');
    fs.writeFileSync(path.join(root, 'Chrome Extension', 'background.js'), 'console.log("edited");\n');
    assert.throws(() => buildPackage({ repoRoot: root, outDir: out }), /uncommitted changes/);
    execFileSync('git', ['-C', root, 'checkout', '--', 'Chrome Extension/background.js']);
    fs.writeFileSync(path.join(root, 'Chrome Extension', 'untracked.js'), '1;\n');
    assert.throws(() => buildPackage({ repoRoot: root, outDir: out }), /untracked\.js/);
  });
});

test('version comparison is numeric per component, as Chrome compares them', () => {
  assert.equal(isNewerVersion('1.3.2', '1.3.0'), true);
  assert.equal(isNewerVersion('1.10.0', '1.9.9'), true);
  assert.equal(isNewerVersion('1.3', '1.3.0'), false);
  assert.equal(isNewerVersion('1.3.0.1', '1.3.0'), true);
  assert.equal(isNewerVersion('1.3.0', '1.3.0'), false);
  assert.equal(isNewerVersion('1.2.9', '1.3.0'), false);
  assert.equal(isNewerVersion('1.3.x', '1.3.0'), false, 'an unparseable part is never newer');
  assert.equal(isNewerVersion('1.0.0', undefined), true);
});

// ── Developer Console ─────────────────────────────────────────────────────────

type Control = { value: string; fills: number; ignoreFill?: boolean; tag?: string };
// A console page reduced to labelled controls. getByRole(role, { name, exact }) finds the
// controls registered under that role and label; only exact lookups are allowed, as the
// script must never match a field by a substring of its label.
function fakeConsolePage(controls: Array<[string, string, string, Partial<Control>?]>, options: string[] = ['Developer Tools', 'English']) {
  const registry = [
    ...controls.map(([role, name, value, extra]) => ({ role, name, state: { value, fills: 0, ...extra } as Control })),
    ...options.map((name) => ({ role: 'option', name, state: { value: '', fills: 0 } as Control })),
  ];
  let openSelect: Control | undefined;
  const clicks: string[] = [];
  const page = {
    getByRole(role: string, query: { name: string; exact?: boolean }) {
      assert.equal(query.exact, true, `lookup of "${query.name}" must be exact`);
      const matches = registry.filter((control) => control.role === role && control.name === query.name);
      return {
        count: async () => matches.length,
        inputValue: async () => matches[0].state.value,
        evaluate: async (fn: (node: unknown) => string) => fn(matches[0].state.tag === 'SELECT'
          ? { tagName: 'SELECT', selectedOptions: [{ textContent: ` ${matches[0].state.value} ` }], innerText: 'Workflow\nDeveloper Tools\nEducation' }
          : { tagName: 'DIV', innerText: ` ${matches[0].state.value}\n` }),
        fill: async (value: string) => { matches[0].state.fills += 1; if (!matches[0].state.ignoreFill) matches[0].state.value = value; },
        click: async () => {
          clicks.push(`${role}:${query.name}`);
          if (role === 'combobox') openSelect = matches[0].state;
          else if (role === 'option' && openSelect) { openSelect.value = query.name; openSelect.fills += 1; }
        },
      };
    },
  };
  return { page, clicks, state: (name: string) => registry.find((control) => control.name === name)!.state };
}
const noLog = () => {};
const field = (label: string, value: string, kind = 'text', tab = '') => ({ tab, label, kind, value });

test('the console plan routes every listing value to its own field', () => {
  const listing = parseListing(listingFixture());
  assert.deepEqual(consoleFieldPlan(listing), [
    field('Description', listing.description),
    field('Category', 'Developer Tools', 'select'),
    field('Language', 'English', 'select'),
    field('Homepage URL', 'https://home.example/repo'),
    field('Support URL', 'https://support.example/issues'),
    field('Single purpose description', 'Fixture purpose.', 'text', 'privacy'),
    field('tabs justification', 'Tabs reason.', 'text', 'privacy'),
    field('storage justification', 'Storage reason.', 'text', 'privacy'),
    field('Host permission justification', 'Host reason.', 'text', 'privacy'),
    field('Privacy policy URL', 'https://privacy.example/policy', 'text', 'privacy'),
  ]);
  assert.equal(editUrl(listing), `https://chrome.google.com/webstore/devconsole/${PUBLISHER}/${ITEM}/edit`);
  assert.equal(editUrl(listing, 'privacy'), `https://chrome.google.com/webstore/devconsole/${PUBLISHER}/${ITEM}/edit/privacy`);
});

test('a dry run reports differing fields and writes none', async () => {
  const { page, state } = fakeConsolePage([['textbox', 'Description', 'old text'], ['textbox', 'Homepage URL', 'https://example.com']]);
  const changes = await syncFields(page, [field('Description', 'new text'), field('Homepage URL', 'https://example.com')], { dryRun: true, log: noLog });
  assert.deepEqual(changes, [{ label: 'Description', from: 'old text', to: 'new text' }]);
  assert.equal(state('Description').fills, 0);
});

test('a write updates only differing fields, selects options and verifies each by reading back', async () => {
  const { page, state, clicks } = fakeConsolePage([['textbox', 'Description', 'old'], ['textbox', 'Support URL', 'same'], ['combobox', 'Category', 'Workflow', { tag: 'SELECT' }]]);
  const changes = await syncFields(page, [field('Description', 'new'), field('Support URL', 'same'), field('Category', 'Developer Tools', 'select')], { dryRun: false, log: noLog });
  assert.deepEqual(changes.map((change) => change.label), ['Description', 'Category']);
  assert.equal(state('Description').value, 'new');
  assert.equal(state('Support URL').fills, 0);
  assert.equal(state('Category').value, 'Developer Tools');
  assert.deepEqual(clicks, ['combobox:Category', 'option:Developer Tools']);
});

test('a select reads its displayed value, not every option it offers', async () => {
  const { page } = fakeConsolePage([['combobox', 'Category', 'Developer Tools', { tag: 'SELECT' }], ['combobox', 'Language', 'English']]);
  assert.deepEqual(await syncFields(page, [field('Category', 'Developer Tools', 'select'), field('Language', 'English', 'select')], { dryRun: true, log: noLog }), []);
});

test('a missing or ambiguous field stops the run before any field is written', async () => {
  const fields = [field('Description', 'new'), field('Homepage URL', 'https://example.com')];
  const missing = fakeConsolePage([['textbox', 'Description', 'old']]);
  await assert.rejects(syncFields(missing.page, fields, { dryRun: false, log: noLog }), /"Homepage URL" matched 0 controls/);
  assert.equal(missing.state('Description').fills, 0, 'the earlier field must not be written when a later one is missing');
  const doubled = fakeConsolePage([['textbox', 'Description', 'old'], ['textbox', 'Homepage URL', ''], ['textbox', 'Homepage URL', '']]);
  await assert.rejects(syncFields(doubled.page, fields, { dryRun: false, log: noLog }), /"Homepage URL" matched 2 controls/);
  assert.equal(doubled.state('Description').fills, 0);
});

test('a select without the wanted option, or a field that drops the value, throws before saving', async () => {
  const { page } = fakeConsolePage([['combobox', 'Category', 'Workflow']], ['Workflow']);
  await assert.rejects(syncFields(page, [field('Category', 'Developer Tools', 'select')], { dryRun: false, log: noLog }), /has no single option "Developer Tools"/);
  const dropped = fakeConsolePage([['textbox', 'Description', 'old', { ignoreFill: true }]]);
  await assert.rejects(syncFields(dropped.page, [field('Description', 'new')], { dryRun: false, log: noLog }), /did not keep the new value/);
});

test('saving needs exactly one Save draft button', async () => {
  for (const [count, ok] of [[1, true], [0, false], [2, false]] as const) {
    let clicked = 0;
    const page = {
      getByRole: (role: string, query: { name: string; exact?: boolean }) => {
        assert.deepEqual([role, query], ['button', { name: 'Save draft', exact: true }]);
        return { count: async () => count, click: async () => { clicked += 1; } };
      },
      waitForLoadState: async () => {},
    };
    if (ok) await saveDraft(page as never);
    else await assert.rejects(saveDraft(page as never), /no single "Save draft" button/);
    assert.equal(clicked, ok ? 1 : 0);
  }
});

function fakeNavigatingPage(urls: string[]) {
  let index = 0;
  let closed = false;
  return { goto: async () => {}, url: () => urls[Math.min(index, urls.length - 1)], waitForLoadState: async () => {}, isClosed: () => closed, close: () => { closed = true; }, advance: () => { index += 1; } };
}

test('opening the console waits while Google asks for sign-in, then requires the exact console page', async () => {
  const target = `https://chrome.google.com/webstore/devconsole/${PUBLISHER}/${ITEM}/edit`;
  const page = fakeNavigatingPage(['https://accounts.google.com/v3/signin/confirmidentifier', 'https://accounts.google.com/v3/signin/challenge', `${target}?hl=en`]);
  const lines: string[] = [];
  await openConsoleTab(page as never, target, { log: (line: string) => lines.push(line), sleep: async () => page.advance() });
  assert.equal(lines.length, 1, 'the sign-in request is logged once');
  assert.match(lines[0], /verify the account in the publisher Chrome window/);

  await assert.rejects(openConsoleTab(fakeNavigatingPage(['https://accounts.google.com/x']) as never, target, { log: noLog, timeoutMs: -1, sleep: async () => {} }), /Timed out waiting for Google sign-in/);
  await assert.rejects(openConsoleTab(fakeNavigatingPage(['https://accounts.google.com/v3/signin/rejected?x=1']) as never, target, { log: noLog, sleep: async () => {} }), /refused to sign in inside the automated publisher Chrome\. Run `npm run store:publish -- --sign-in`/);
  const closing = fakeNavigatingPage(['https://accounts.google.com/x']);
  await assert.rejects(openConsoleTab(closing as never, target, { log: noLog, sleep: async () => closing.close() }), /window was closed before Google sign-in finished/);
  await assert.rejects(openConsoleTab(fakeNavigatingPage([`${target}/privacy`]) as never, target, { log: noLog, sleep: async () => {} }), /instead of/);
  await assert.rejects(openConsoleTab(fakeNavigatingPage(['https://chrome.google.com/webstore/devconsole']) as never, target, { log: noLog, sleep: async () => {} }), /instead of/);
});

test('the publisher Chrome starts on its own profile, is reused while it answers, and is closed over CDP', async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-profile-'));
  try {
    const spawned: string[][] = [];
    const spawnImpl = ((binary: string, args: string[]) => {
      spawned.push([binary, ...args]);
      fs.writeFileSync(path.join(profileDir, 'DevToolsActivePort'), '43211\n/devtools/browser/x\n');
      return { unref() {} };
    }) as never;
    const fetchImpl = (async (url: string) => ({ ok: url === 'http://127.0.0.1:43211/json/version' })) as never;
    assert.deepEqual(await startPublisherChrome({ profileDir, chromeBinary: '/fake/chrome', spawnImpl, fetchImpl, sleep: async () => {} }), { port: 43211, started: true });
    assert.deepEqual(spawned, [['/fake/chrome', `--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check']]);
    assert.deepEqual(await startPublisherChrome({ profileDir, chromeBinary: '/fake/chrome', spawnImpl, fetchImpl, sleep: async () => {} }), { port: 43211, started: false });
    assert.equal(spawned.length, 1, 'a running publisher Chrome is reused');
    await assert.rejects(startPublisherChrome({ profileDir, chromeBinary: '/fake/chrome', spawnImpl, fetchImpl: (async () => ({ ok: false })) as never, sleep: async () => {}, startupChecks: 2 }), /did not open its DevTools port/);

    // A profile held by a plain Chrome (after --sign-in) cannot be driven; say so instead of launching into it.
    fs.rmSync(path.join(profileDir, 'DevToolsActivePort'));
    const before = spawned.length;
    await assert.rejects(startPublisherChrome({ profileDir, chromeBinary: '/fake/chrome', spawnImpl, fetchImpl, sleep: async () => {}, isProfileInUse: () => true }), /open in a Chrome without automation .*quit that Chrome \(Cmd\+Q\)/);
    assert.equal(spawned.length, before, 'nothing is launched into a profile another Chrome holds');

    const sent: string[] = [];
    await closePublisherChrome({ newBrowserCDPSession: async () => ({ send: async (method: string) => { sent.push(method); } }) } as never);
    assert.deepEqual(sent, ['Browser.close']);
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});

// ── Publish run ───────────────────────────────────────────────────────────────

const pkgFixture = { path: '/tmp/x.zip', commit: 'a'.repeat(40), version: '2.0.1', manifest: fixtureManifest, entries: ['manifest.json'], bytes: Buffer.from('zip'), sha256: 'f'.repeat(64) };

// Fakes that check what they are given: wrong ids, bytes, URLs or tokens fail the test.
function publishDeps({ consoleDiffs = { '': ['Description'], privacy: [] as string[] }, keepsSaves = true, ...overrides }: Record<string, any> = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  let currentTab = '';
  const saved = new Set<string>();
  const status = (version?: string, submitted?: string) => ({ itemId: ITEM, publishedItemRevisionStatus: version ? { distributionChannels: [{ crxVersion: version }] } : undefined, submittedItemRevisionStatus: submitted ? { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: submitted }] } : undefined });
  const statuses = [status('2.0.0'), status('2.0.0', '2.0.1')];
  const expectIds = (request: Record<string, unknown>) => {
    assert.equal(request.token, 'token');
    assert.equal(request.publisherId, PUBLISHER);
    assert.equal(request.itemId, ITEM);
  };
  const deps = {
    log: (line: string) => lines.push(line),
    env: { CWS_CLIENT_ID: 'i', CWS_CLIENT_SECRET: 's', CWS_REFRESH_TOKEN: 'r' },
    sleep: async () => {},
    readListing: () => listingFixture(),
    buildPackage: () => pkgFixture,
    startPublisherChrome: async () => { calls.push('startChrome'); return { port: 9 }; },
    connectOverCDP: async (endpoint: string) => {
      assert.equal(endpoint, 'http://127.0.0.1:9');
      return { contexts: () => [{ newPage: async () => ({}) }], close: async () => { calls.push('disconnect'); } };
    },
    closePublisherChrome: async () => { calls.push('closeChrome'); },
    openConsoleTab: async (_page: unknown, url: string) => {
      const prefix = `https://chrome.google.com/webstore/devconsole/${PUBLISHER}/${ITEM}/edit`;
      assert.ok(url === prefix || url === `${prefix}/privacy`, `unexpected console URL ${url}`);
      currentTab = url === prefix ? '' : 'privacy';
      calls.push(`open:${currentTab || 'listing'}`);
    },
    syncFields: async (_page: unknown, fields: Array<{ tab: string; label: string }>, { dryRun }: { dryRun: boolean }) => {
      assert.ok(fields.length > 0 && fields.every((f) => f.tab === currentTab), 'fields must belong to the open tab');
      calls.push(`sync:${currentTab || 'listing'}:${dryRun ? 'read' : 'write'}`);
      if (consoleDiffs[currentTab] === 'missing') throw new Error('Console field "x" matched 0 controls');
      if (saved.has(currentTab) && keepsSaves) return [];
      return (consoleDiffs[currentTab] ?? []).map((label: string) => ({ label }));
    },
    saveDraft: async () => { calls.push(`save:${currentTab || 'listing'}`); saved.add(currentTab); },
    inspectControls: async () => [{ role: 'textbox', name: 'Description' }],
    fetchAccessToken: async (credentials: Record<string, string>) => { assert.deepEqual(credentials, { clientId: 'i', clientSecret: 's', refreshToken: 'r' }); calls.push('token'); return 'token'; },
    fetchStatus: async (request: Record<string, unknown>) => { expectIds(request); calls.push('status'); return statuses.length > 1 ? statuses.shift() : statuses[0]; },
    uploadPackage: async (request: Record<string, unknown>) => { expectIds(request); assert.equal(request.zip, pkgFixture.bytes); calls.push('upload'); return { uploadState: 'SUCCEEDED', crxVersion: '2.0.1' }; },
    publishItem: async (request: Record<string, unknown>) => { expectIds(request); calls.push('publish'); return { state: 'PENDING_REVIEW', warningInfo: { warnings: [{ reason: 'W1', description: 'synthetic warning' }] } }; },
    ...overrides,
  };
  return { deps, calls, lines };
}

test('options accept only the documented flags, and --inspect runs alone', () => {
  assert.deepEqual(parseArgs([]), { diff: false, listing: false, upload: false, submit: false, inspect: false, signIn: false });
  assert.deepEqual(parseArgs(['--upload', '--submit']), { diff: false, listing: false, upload: true, submit: true, inspect: false, signIn: false });
  assert.throws(() => parseArgs(['--publish']), /Unknown option --publish/);
  assert.throws(() => parseArgs(['--inspect', '--listing']), /--inspect runs alone/);
});

test('the default check validates and packages without a browser or the API', async () => {
  const { deps, calls, lines } = publishDeps();
  await runPublish(parseArgs([]), deps);
  assert.deepEqual(calls, []);
  assert.match(lines.join('\n'), /sha256 f{64}/);
  assert.match(lines.at(-1)!, /Nothing was written/);
});

test('--diff reads both console tabs, writes nothing and closes the publisher Chrome', async () => {
  const { deps, calls } = publishDeps();
  await runPublish(parseArgs(['--diff']), deps);
  assert.deepEqual(calls, ['startChrome', 'open:listing', 'sync:listing:read', 'open:privacy', 'sync:privacy:read', 'closeChrome', 'disconnect']);
});

test('--listing saves only the tab that differs and reads it back after reloading', async () => {
  const { deps, calls } = publishDeps();
  await runPublish(parseArgs(['--listing']), deps);
  assert.deepEqual(calls, [
    'startChrome', 'open:listing', 'sync:listing:read', 'open:privacy', 'sync:privacy:read',
    'open:listing', 'sync:listing:write', 'save:listing', 'open:listing', 'sync:listing:read',
    'closeChrome', 'disconnect',
  ]);
});

test('--listing fails when the reloaded console does not show the saved text', async () => {
  const { deps } = publishDeps({ keepsSaves: false });
  await assert.rejects(runPublish(parseArgs(['--listing']), deps), /did not keep the saved store listing fields: Description/);
});

test('a field missing on the second tab stops --listing before the first tab is written', async () => {
  const { deps, calls } = publishDeps({ consoleDiffs: { '': ['Description'], privacy: 'missing' } });
  await assert.rejects(runPublish(parseArgs(['--listing']), deps), /matched 0 controls/);
  assert.ok(!calls.some((call) => call.includes(':write') || call.startsWith('save')), `nothing may be written: ${calls.join(', ')}`);
  assert.deepEqual(calls.slice(-2), ['closeChrome', 'disconnect'], 'the publisher Chrome is closed even when the run fails');
});

test('--upload --submit uploads the package bytes, submits and confirms the submitted version', async () => {
  const { deps, calls, lines } = publishDeps();
  await runPublish(parseArgs(['--upload', '--submit']), deps);
  assert.deepEqual(calls, ['token', 'status', 'upload', 'publish', 'status']);
  const log = lines.join('\n');
  assert.match(log, /warning W1: synthetic warning/);
  assert.match(log, /Submitted 2\.0\.1 for review: state PENDING_REVIEW/);
});

test('API preconditions are checked before the console is written', async () => {
  const noCredentials = publishDeps({ env: {} });
  await assert.rejects(runPublish(parseArgs(['--listing', '--upload']), noCredentials.deps), /credentials are missing/);
  assert.deepEqual(noCredentials.calls, []);
  const stale = publishDeps({ fetchStatus: async () => ({ itemId: ITEM, publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: '2.0.1' }] } }) });
  await assert.rejects(runPublish(parseArgs(['--listing', '--upload']), stale.deps), /not newer than the published 2\.0\.1/);
  assert.ok(!stale.calls.includes('startChrome') && !stale.calls.includes('upload'));
});

test('a version mismatch after upload or submission fails the run', async () => {
  const parsedWrong = publishDeps({ uploadPackage: async () => ({ uploadState: 'SUCCEEDED', crxVersion: '0.0.1' }) });
  await assert.rejects(runPublish(parseArgs(['--upload']), parsedWrong.deps), /parsed version 0\.0\.1/);

  let statusCalls = 0;
  const submittedWrong = publishDeps({ fetchStatus: async () => {
    statusCalls += 1;
    return statusCalls === 1
      ? { itemId: ITEM, publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: '2.0.0' }] } }
      : { itemId: ITEM, submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.9.0' }] } };
  } });
  await assert.rejects(runPublish(parseArgs(['--submit']), submittedWrong.deps), /holds version 1\.9\.0 for review, expected 2\.0\.1/);
});

test('an asynchronous upload is accepted and its version is confirmed on submission', async () => {
  let statusCalls = 0;
  const { deps, lines } = publishDeps({
    uploadPackage: async () => ({ uploadState: 'IN_PROGRESS' }),
    fetchStatus: async () => {
      statusCalls += 1;
      if (statusCalls === 1) return { itemId: ITEM, publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: '2.0.0' }] } };
      if (statusCalls === 2) return { itemId: ITEM, lastAsyncUploadState: 'SUCCEEDED' };
      return { itemId: ITEM, submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '2.0.1' }] } };
    },
  });
  await runPublish(parseArgs(['--upload', '--submit']), deps);
  assert.match(lines.join('\n'), /reports the parsed version once it is submitted/);
  assert.match(lines.join('\n'), /Submitted 2\.0\.1 for review/);
});

test('a listing that does not match the package stops before the console or the API', async () => {
  const { deps, calls } = publishDeps({ buildPackage: () => ({ ...pkgFixture, manifest: { ...fixtureManifest, description: 'Stale summary' } }) });
  await assert.rejects(runPublish(parseArgs(['--listing', '--upload']), deps), /summary must equal the manifest description/);
  assert.deepEqual(calls, []);
});

test('--inspect lists the controls on both tabs and closes the publisher Chrome', async () => {
  const { deps, calls, lines } = publishDeps();
  await runPublish(parseArgs(['--inspect']), deps);
  assert.deepEqual(calls, ['startChrome', 'open:listing', 'open:privacy', 'closeChrome', 'disconnect']);
  assert.equal(lines.filter((line) => line === '  textbox: Description').length, 2);
});

test('sign-in opens the profile as plain Chrome without a DevTools port, and refuses a profile already open', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-profile-'));
  try {
    const spawned: string[][] = [];
    const spawnImpl = ((binary: string, args: string[]) => { spawned.push([binary, ...args]); return { unref() {} }; }) as never;
    openSignInChrome('https://console.example/edit', { profileDir, chromeBinary: '/fake/chrome', spawnImpl, isProfileInUse: () => false });
    assert.deepEqual(spawned, [['/fake/chrome', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', 'https://console.example/edit']]);
    assert.ok(!spawned[0].some((arg) => arg.startsWith('--remote-debugging')), 'Google refuses sign-in in a DevTools-driven browser');
    assert.throws(() => openSignInChrome('https://console.example/edit', { profileDir, chromeBinary: '/fake/chrome', spawnImpl, isProfileInUse: () => true }), /already open/);
    assert.equal(spawned.length, 1);
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});

test('the profile counts as in use only while the process named by its lock is alive', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-profile-'));
  try {
    assert.equal(profileInUse(profileDir), false, 'no lock');
    fs.symlinkSync(`host.local-${process.pid}`, path.join(profileDir, 'SingletonLock'));
    assert.equal(profileInUse(profileDir), true, 'lock held by a live process');
    fs.rmSync(path.join(profileDir, 'SingletonLock'));
    fs.symlinkSync('host.local-2147483646', path.join(profileDir, 'SingletonLock'));
    assert.equal(profileInUse(profileDir), false, 'stale lock from a dead process');
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});

test('--sign-in opens the console in the plain publisher profile without building or driving anything', async () => {
  const opened: string[] = [];
  const { deps, calls, lines } = publishDeps({ openSignInChrome: (url: string) => { opened.push(url); }, buildPackage: () => assert.fail('no package for sign-in') });
  await runPublish(parseArgs(['--sign-in']), deps);
  assert.deepEqual(opened, [`https://chrome.google.com/webstore/devconsole/${PUBLISHER}/${ITEM}/edit`]);
  assert.deepEqual(calls, []);
  assert.match(lines.join('\n'), /quit that Chrome \(Cmd\+Q\)/);
  assert.throws(() => parseArgs(['--sign-in', '--diff']), /--sign-in runs alone/);
  assert.equal(parseArgs(['--sign-in']).signIn, true);
});
