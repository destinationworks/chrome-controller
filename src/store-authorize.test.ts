import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apiCredentials, clientCredentials, keychain, KEYCHAIN_SERVICE } from '../scripts/store-credentials.js';
import { authorize, AUTH_URL, SCOPE } from '../scripts/store-oauth.js';

// Synthetic credentials: shaped like Google's, valid nowhere.
const CLIENT = { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-synthetic_secret' };
const REFRESH = '1//0synthetic-refresh_token';

type Run = { command: string; args: string[]; input?: string };

// A fake `security` that keeps items in memory and records every invocation.
function fakeSecurity({ status = {} as Record<string, number>, keepsWrites = true, missing = false } = {}) {
  const items = new Map<string, string>();
  const runs: Run[] = [];
  const run = (command: string, args: string[], options: { input?: string }) => {
    runs.push({ command, args, input: options.input });
    if (missing) return { status: null, error: Object.assign(new Error('spawn security ENOENT'), { code: 'ENOENT' }), stdout: '' };
    if (args[0] === '-i') {
      if (status.write !== undefined) return { status: status.write, stdout: '' };
      const [, , , service, , account, , value] = options.input!.trim().split(' ');
      if (keepsWrites) items.set(`${service}/${account}`, value);
      return { status: 0, stdout: '' };
    }
    if (status.read !== undefined) return { status: status.read, stdout: '' };
    const value = items.get(`${args[2]}/${args[4]}`);
    return value === undefined ? { status: 44, stdout: '' } : { status: 0, stdout: `${value}\n` };
  };
  return { run, runs, items };
}

test('the Keychain is read with the service and account as arguments and the value from stdout', () => {
  const security = fakeSecurity();
  security.items.set(`${KEYCHAIN_SERVICE}/client_id`, CLIENT.clientId);
  const store = keychain({ run: security.run });
  assert.equal(store.read('client_id'), CLIENT.clientId, 'the trailing newline is dropped');
  assert.deepEqual(security.runs[0].args, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'client_id', '-w']);
  assert.equal(store.read('refresh_token'), undefined, 'exit 44 means the item does not exist');
});

test('a Keychain value is written on stdin, never in argv, and must read back', () => {
  const security = fakeSecurity();
  const store = keychain({ run: security.run });
  store.write('refresh_token', REFRESH);
  const write = security.runs.find((run) => run.args[0] === '-i')!;
  assert.deepEqual(write.args, ['-i']);
  assert.equal(write.input, `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a refresh_token -w ${REFRESH}\n`);
  assert.ok(security.runs.every((run) => !run.args.join(' ').includes(REFRESH)), 'the value never appears in argv');
  assert.equal(store.read('refresh_token'), REFRESH);

  const forgetful = fakeSecurity({ keepsWrites: false });
  assert.throws(() => keychain({ run: forgetful.run }).write('refresh_token', REFRESH), /did not keep refresh_token/);
});

test('values the security command line cannot carry are refused before anything runs', () => {
  const security = fakeSecurity();
  const store = keychain({ run: security.run });
  for (const value of ['', 'has space', 'quote"d', "single'q", 'back\\slash', 'new\nline', '-starts-with-dash', 'tab\tbed']) {
    assert.throws(() => store.write('client_secret', value), /cannot carry; nothing was stored/, JSON.stringify(value));
  }
  assert.equal(security.runs.length, 0);
  assert.throws(() => keychain({ run: security.run, file: 'relative.keychain' }), /absolute path without spaces/);
  assert.throws(() => keychain({ run: security.run, file: '/with space/x.keychain' }), /absolute path without spaces/);
});

test('Keychain failures name the account and exit status but never the value', () => {
  const reading = keychain({ run: fakeSecurity({ status: { read: 51 } }).run });
  assert.throws(() => reading.read('client_secret'), /Reading client_secret in the Keychain failed \(security exit 51\)/);
  const writing = keychain({ run: fakeSecurity({ status: { write: 1 } }).run });
  assert.throws(() => writing.write('client_secret', CLIENT.clientSecret), (error: Error) => {
    assert.match(error.message, /Writing client_secret in the Keychain failed \(security exit 1\)/);
    assert.ok(!error.message.includes(CLIENT.clientSecret));
    return true;
  });
  const absent = keychain({ run: fakeSecurity({ missing: true }).run });
  assert.throws(() => absent.read('client_id'), /needs the macOS `security` tool; elsewhere set CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN/);
});

test('a real keychain stores and returns OAuth-shaped values through the security tool', { skip: process.platform !== 'darwin' && 'needs macOS security' }, () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'store-keychain-'));
  const file = path.join(dir, 'test.keychain-db');
  const password = 'synthetic-keychain-password';
  execFileSync('security', ['create-keychain', '-p', password, file]);
  try {
    execFileSync('security', ['unlock-keychain', '-p', password, file]);
    const store = keychain({ file, service: 'chrome-controller-store-api-test' });
    assert.equal(store.read('refresh_token'), undefined);
    store.write('refresh_token', REFRESH);
    store.write('client_secret', CLIENT.clientSecret);
    assert.equal(store.read('refresh_token'), REFRESH);
    assert.equal(store.read('client_secret'), CLIENT.clientSecret);
    store.write('refresh_token', `${REFRESH}-rotated`);
    assert.equal(store.read('refresh_token'), `${REFRESH}-rotated`, '-U replaces the existing item');
    const login = spawnSync('security', ['find-generic-password', '-s', 'chrome-controller-store-api-test', '-a', 'refresh_token'], { encoding: 'utf8' });
    assert.notEqual(login.status, 0, 'nothing was written outside the given keychain');
  } finally {
    spawnSync('security', ['delete-keychain', file]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function memoryStore(entries: Record<string, string>) {
  const reads: string[] = [];
  return { reads, store: { read: (account: string) => { reads.push(account); return entries[account]; }, write: () => { throw new Error('unexpected write'); } } };
}

test('API credentials come from all three variables, or from the Keychain when none is set', () => {
  const unused = memoryStore({});
  assert.deepEqual(apiCredentials({ CWS_CLIENT_ID: 'i', CWS_CLIENT_SECRET: 's', CWS_REFRESH_TOKEN: 'r' }, unused.store), { clientId: 'i', clientSecret: 's', refreshToken: 'r' });
  assert.deepEqual(unused.reads, [], 'variables win without touching the Keychain');
  assert.throws(() => apiCredentials({ CWS_CLIENT_ID: 'i' }, unused.store), /incomplete: CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN unset/);

  const full = memoryStore({ client_id: 'ki', client_secret: 'ks', refresh_token: 'kr' });
  assert.deepEqual(apiCredentials({}, full.store), { clientId: 'ki', clientSecret: 'ks', refreshToken: 'kr' });
  assert.deepEqual(full.reads, ['client_id', 'client_secret', 'refresh_token']);
});

test('missing Keychain entries are named, with the step that creates them, and no values', () => {
  const noToken = memoryStore({ client_id: 'ki', client_secret: 'ks' });
  assert.throws(() => apiCredentials({}, noToken.store), (error: Error) => {
    assert.match(error.message, /missing from the Keychain service "chrome-controller-store-api": refresh_token\. Either run `npm run store:publish -- --authorize`/);
    assert.ok(!error.message.includes('ks'));
    return true;
  });
  assert.throws(() => apiCredentials({}, memoryStore({ client_id: 'ki' }).store), /: client_secret, refresh_token\. Either store the OAuth client first/);
  assert.throws(() => apiCredentials({}, memoryStore({ refresh_token: 'kr' }).store), /: client_id, client_secret\. Either store the OAuth client first/);
});

test('--authorize takes only the client from the Keychain and refuses CWS variables that would override its token', () => {
  const store = memoryStore({ client_id: 'ki', client_secret: 'ks', refresh_token: 'old' });
  assert.deepEqual(clientCredentials({}, store.store), { clientId: 'ki', clientSecret: 'ks' });
  assert.deepEqual(store.reads, ['client_id', 'client_secret'], 'the old refresh token is not needed');
  assert.throws(() => clientCredentials({ CWS_REFRESH_TOKEN: 'r' }, store.store), /CWS_REFRESH_TOKEN would override it on later runs; unset them first/);
  assert.throws(() => clientCredentials({ CWS_CLIENT_ID: 'i', CWS_CLIENT_SECRET: 's' }, store.store), /CWS_CLIENT_ID, CWS_CLIENT_SECRET would override/);
  assert.throws(() => clientCredentials({}, memoryStore({ client_id: 'ki' }).store), /OAuth client is missing from the Keychain service "chrome-controller-store-api": client_secret/);
});

// Runs authorize() against its real loopback server; `browser` plays the redirect Google would send.
async function runAuthorize({ browser, token = { refresh_token: REFRESH, scope: SCOPE } as unknown, tokenStatus = 200, timeoutMs = 5_000 }: {
  browser: (redirect: { uri: string; state: string; challenge: string; url: URL }) => Promise<unknown>;
  token?: unknown; tokenStatus?: number; timeoutMs?: number;
}) {
  const lines: string[] = [];
  const exchanges: Array<{ url: string; body: URLSearchParams }> = [];
  let browsed: Promise<unknown> | undefined;
  let redirectUri = '';
  const log = (line: string) => {
    lines.push(line);
    const url = new URL(line.split('\n')[1]);
    redirectUri = url.searchParams.get('redirect_uri')!;
    browsed = browser({ uri: redirectUri, state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')!, url });
  };
  const fetchImpl = async (url: string, init: { method: string; body: string }) => {
    assert.equal(init.method, 'POST');
    exchanges.push({ url, body: new URLSearchParams(init.body) });
    return new Response(JSON.stringify(token), { status: tokenStatus });
  };
  const result = authorize(CLIENT, { log, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs });
  const outcome = await result.then((value) => ({ value }), (error: Error) => ({ error }));
  return { outcome, lines, exchanges, browserResult: await browsed, redirectUri };
}

async function closed(uri: string) {
  return fetch(uri).then(() => false, () => true);
}

test('authorization runs the PKCE loopback flow and exchanges the code for a refresh token', async () => {
  const { outcome, lines, exchanges, browserResult, redirectUri } = await runAuthorize({
    browser: async ({ uri, state }) => {
      const favicon = await fetch(`${uri}/favicon.ico`);
      const answer = await fetch(`${uri}/?state=${state}&code=synthetic-code&scope=${encodeURIComponent(SCOPE)}`);
      return { favicon: favicon.status, status: answer.status, page: await answer.text() };
    },
  });
  assert.deepEqual(outcome, { value: REFRESH });
  assert.deepEqual(browserResult, { favicon: 404, status: 200, page: '<!doctype html><meta charset="utf-8"><title>Chrome Web Store API</title><p>Authorized. You can close this tab.</p>' });

  const url = new URL(lines[0].split('\n')[1]);
  assert.equal(`${url.origin}${url.pathname}`, AUTH_URL);
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+$/);
  const params = Object.fromEntries(url.searchParams);
  assert.deepEqual({ ...params, state: undefined, code_challenge: undefined }, {
    client_id: CLIENT.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256', state: undefined, code_challenge: undefined,
  });
  assert.match(params.state, /^[\w-]{22}$/);

  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].url, 'https://oauth2.googleapis.com/token');
  const body = Object.fromEntries(exchanges[0].body);
  assert.deepEqual({ ...body, code_verifier: undefined }, {
    code: 'synthetic-code', client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: undefined,
  });
  assert.match(body.code_verifier, /^[\w-]{43}$/);
  assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), params.code_challenge, 'the challenge is the S256 of the verifier');

  const logged = lines.join('\n');
  for (const secret of [CLIENT.clientSecret, REFRESH, body.code_verifier]) assert.ok(!logged.includes(secret), 'secrets are never logged');
  assert.ok(await closed(redirectUri), 'the loopback server is closed once the code arrived');
});

test('each run uses a fresh state and verifier', async () => {
  const challenges: string[] = [];
  for (let run = 0; run < 2; run += 1) {
    await runAuthorize({ browser: async ({ uri, state, challenge }) => { challenges.push(`${state}/${challenge}`); return fetch(`${uri}/?state=${state}&code=c`); } });
  }
  assert.notEqual(challenges[0], challenges[1]);
});

test('an answer with another state, an error or no code fails without exchanging anything', async () => {
  const cases: Array<[string, (state: string) => string, RegExp, string]> = [
    ['foreign state', () => '?state=forged&code=c', /state that does not match this run; nothing was stored/, 'This answer belongs to another authorization run.'],
    ['no state', () => '?code=c', /state that does not match/, 'This answer belongs to another authorization run.'],
    ['refused', (state) => `?state=${state}&error=access_denied`, /Authorization was refused: access_denied/, 'Authorization was refused.'],
    ['no code', (state) => `?state=${state}`, /without an authorization code; nothing was stored/, 'Google sent no authorization code.'],
  ];
  for (const [name, query, expected, message] of cases) {
    const { outcome, exchanges, browserResult, redirectUri } = await runAuthorize({
      browser: async ({ uri, state }) => { const answer = await fetch(`${uri}/${query(state)}`); return { status: answer.status, page: await answer.text() }; },
    });
    assert.match(String((outcome as { error?: Error }).error?.message), expected, name);
    assert.deepEqual(browserResult, { status: 400, page: `<!doctype html><meta charset="utf-8"><title>Chrome Web Store API</title><p>${message}</p>` }, name);
    assert.equal(exchanges.length, 0, `${name}: nothing is exchanged`);
    assert.ok(await closed(redirectUri), `${name}: the server is closed`);
  }
});

test('a token answer without a refresh token, without the scope, or with an error fails', async () => {
  const browser = async ({ uri, state }: { uri: string; state: string }) => fetch(`${uri}/?state=${state}&code=c`);
  const cases: Array<[unknown, number, RegExp]> = [
    [{ access_token: 'a', scope: SCOPE }, 200, /Google returned no refresh token; nothing was stored/],
    [{ refresh_token: '', scope: SCOPE }, 200, /no refresh token/],
    [{ refresh_token: REFRESH, scope: 'openid email' }, 200, /without the scope https:\/\/www\.googleapis\.com\/auth\/chromewebstore/],
    [{ refresh_token: REFRESH }, 200, /without the scope/],
    [{ error: 'invalid_grant', error_description: 'Bad code verifier.' }, 400, /Authorization code exchange failed with HTTP 400: Bad code verifier\./],
  ];
  for (const [token, tokenStatus, expected] of cases) {
    const { outcome } = await runAuthorize({ browser, token, tokenStatus });
    const message = String((outcome as { error?: Error }).error?.message);
    assert.match(message, expected);
    assert.ok(!message.includes(CLIENT.clientSecret) && !message.includes(REFRESH));
  }
});

test('authorization gives up after its timeout and closes the loopback server', async () => {
  const { outcome, exchanges, redirectUri } = await runAuthorize({ browser: async () => undefined, timeoutMs: 2_000 });
  assert.match(String((outcome as { error?: Error }).error?.message), /No authorization arrived within 2 seconds; nothing was stored/);
  assert.equal(exchanges.length, 0);
  assert.ok(await closed(redirectUri));
});
