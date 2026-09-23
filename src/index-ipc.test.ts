/**
 * Native Messaging IPC tests for the Pi extension (src/index.ts).
 *
 * Each test runs a fake native host (a net.Server on a temp Unix socket
 * selected via CHROME_CONTROLLER_SOCKET) and a counting fetch mock, so it can
 * prove both what the Pi tool returned and whether the HTTP relay was touched.
 *
 * Run: npx tsx --test src/index-ipc.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import chromeControllerPiExtension from './index.ts';

const TEST_API_KEY = 'test-key-0123456789abcdef01234567';
const IPC_TIMEOUT_MS = 400;
const ENV_KEYS = [
  'CHROME_CONTROLLER_SOCKET',
  'CHROME_CONTROLLER_URL',
  'CHROME_CONTROLLER_ALLOW_RELAY',
  'CHROME_CONTROLLER_API_KEY',
  'CHROME_CONTROLLER_INSTANCE',
  'HTTP_PORT',
  'API_KEY',
] as const;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ipc-'));
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = global.fetch;
let relayCalls: string[] = [];
let socketCounter = 0;

test.beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  // A discovery file for an unused instance never exists, so relay config
  // comes only from what each test sets explicitly.
  process.env.CHROME_CONTROLLER_INSTANCE = `pi-ipc-test-${process.pid}`;
  relayCalls = [];
  global.fetch = (async (url: string | URL | Request) => {
    relayCalls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: 'from-relay', extensionConnected: true }),
    } as Response;
  }) as typeof fetch;
});

test.after(() => {
  global.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function allowRelay(): void {
  process.env.CHROME_CONTROLLER_ALLOW_RELAY = '1';
  process.env.CHROME_CONTROLLER_API_KEY = TEST_API_KEY;
}

type FakeHost = {
  socketPath: string;
  requests: Record<string, unknown>[];
  /** Connections on which the client sent FIN, i.e. closed its side after an answer. */
  clientEnds: () => number;
  close: () => Promise<void>;
};

const openServers = new Set<() => Promise<void>>();

// Hosts left open by a failed assertion would keep the test process alive.
test.afterEach(async () => {
  await Promise.all([...openServers].map((close) => close()));
});

/** Starts a fake native host. `onRequest` gets each parsed request line and the raw socket. */
async function startFakeHost(
  onRequest: (request: Record<string, unknown>, socket: net.Socket) => void,
): Promise<FakeHost> {
  const socketPath = path.join(tmpDir, `h${socketCounter++}.sock`);
  const requests: Record<string, unknown>[] = [];
  const sockets = new Set<net.Socket>();
  let clientEnds = 0;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    // Like the real host, never close our side first: only count the client's FIN.
    socket.on('end', () => { clientEnds++; });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      buffer = buffer.slice(newline + 1);
      requests.push(request);
      onRequest(request, socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  process.env.CHROME_CONTROLLER_SOCKET = socketPath;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
    openServers.delete(close);
    return closing;
  };
  openServers.add(close);
  return { socketPath, requests, clientEnds: () => clientEnds, close };
}

type Tool = { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

function loadTools(): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  const pi = { registerTool: (tool: Tool & { name: string }) => { tools[tool.name] = tool; } };
  chromeControllerPiExtension(pi as unknown as ExtensionAPI, { ipcTimeoutMs: IPC_TIMEOUT_MS });
  return tools;
}

function parsed(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ── Connect failures: the only case that may use the relay ───────────────────

test('connect failure without relay permission reports NATIVE_IPC_UNAVAILABLE and never touches the relay', async () => {
  process.env.CHROME_CONTROLLER_SOCKET = path.join(tmpDir, 'missing.sock');
  const tools = loadTools();
  await assert.rejects(
    () => tools['chrome_create_tab'].execute('c1', { url: 'https://example.com' }, undefined),
    (err: Error) => {
      assert.match(err.message, /^NATIVE_IPC_UNAVAILABLE: /);
      assert.ok(err.message.includes('missing.sock'));
      assert.match(err.message, /ENOENT/);
      return true;
    },
  );
  assert.deepEqual(relayCalls, []);
});

test('connect failure with relay permission falls back to the relay', async () => {
  process.env.CHROME_CONTROLLER_SOCKET = path.join(tmpDir, 'missing.sock');
  allowRelay();
  const tools = loadTools();
  const result = parsed(await tools['chrome_create_tab'].execute('c1', { url: 'https://example.com' }, undefined));
  assert.equal(result.result, 'from-relay');
  assert.deepEqual(relayCalls, ['http://127.0.0.1:8898']);
});

/** A socket file whose listener is gone, as a crashed host leaves behind. */
async function staleSocket(): Promise<string> {
  const livePath = path.join(tmpDir, `live${socketCounter++}.sock`);
  const stalePath = path.join(tmpDir, `stale${socketCounter++}.sock`);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(livePath, resolve));
  // server.close() unlinks its own path, so keep a second name for the inode.
  fs.linkSync(livePath, stalePath);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return stalePath;
}

test('a stale socket file (ECONNREFUSED) is a connect failure that may fall back', async () => {
  process.env.CHROME_CONTROLLER_SOCKET = await staleSocket();
  await assert.rejects(
    () => loadTools()['chrome_query_tabs'].execute('c1', {}, undefined),
    { message: /^NATIVE_IPC_UNAVAILABLE: .*ECONNREFUSED/ },
  );
  assert.deepEqual(relayCalls, []);

  allowRelay();
  const result = parsed(await loadTools()['chrome_query_tabs'].execute('c2', { mode: 'full' }, undefined));
  assert.equal(result.result, 'from-relay');
  assert.equal(relayCalls.length, 1);
});

test('relay fallback needs CHROME_CONTROLLER_ALLOW_RELAY to be exactly "1"', async () => {
  process.env.CHROME_CONTROLLER_SOCKET = path.join(tmpDir, 'missing.sock');
  process.env.CHROME_CONTROLLER_API_KEY = TEST_API_KEY;
  for (const value of ['0', 'true', '']) {
    process.env.CHROME_CONTROLLER_ALLOW_RELAY = value;
    await assert.rejects(
      () => loadTools()['chrome_query_tabs'].execute('c1', {}, undefined),
      { message: /^NATIVE_IPC_UNAVAILABLE: / },
      `CHROME_CONTROLLER_ALLOW_RELAY=${JSON.stringify(value)} must not enable the relay`,
    );
  }
  assert.deepEqual(relayCalls, []);
});

test('HTTP_PORT alone enables relay fallback, to that port', async () => {
  process.env.CHROME_CONTROLLER_SOCKET = path.join(tmpDir, 'missing.sock');
  process.env.HTTP_PORT = '9123';
  process.env.CHROME_CONTROLLER_API_KEY = TEST_API_KEY;
  const result = parsed(await loadTools()['chrome_query_tabs'].execute('c1', { mode: 'full' }, undefined));
  assert.equal(result.result, 'from-relay');
  assert.deepEqual(relayCalls, ['http://127.0.0.1:9123']);
});

test('a numeric socket path is treated as a path, never as a TCP port', async () => {
  // net.connect('8898') would dial TCP 127.0.0.1:8898, the relay's port.
  process.env.CHROME_CONTROLLER_SOCKET = '99999';
  await assert.rejects(
    () => loadTools()['chrome_query_tabs'].execute('c1', {}, undefined),
    { message: /^NATIVE_IPC_UNAVAILABLE: .*ENOENT/ },
  );
});

// ── Failures after the request reached the host: never replayed ──────────────

test('a host that accepts but never answers reports NATIVE_IPC_TIMEOUT and is not replayed over the relay', async () => {
  const host = await startFakeHost(() => { /* swallow the request */ });
  allowRelay();
  const tools = loadTools();
  const started = Date.now();
  try {
    await assert.rejects(
      () => tools['chrome_click'].execute('c1', { tabId: 7, selector: '#buy' }, undefined),
      (err: Error) => {
        assert.match(err.message, /^NATIVE_IPC_TIMEOUT: /);
        assert.match(err.message, new RegExp(`within ${IPC_TIMEOUT_MS}ms`));
        assert.match(err.message, /npm run watchdog/);
        assert.match(err.message, /not retried/);
        return true;
      },
    );
    assert.ok(Date.now() - started >= IPC_TIMEOUT_MS - 20, 'must wait for the injected timeout');
    assert.equal(host.requests.length, 1, 'the host received the click');
    assert.deepEqual(relayCalls, [], 'the click must not be replayed over the relay');
  } finally {
    await host.close();
  }
});

test('an unparseable host answer reports NATIVE_IPC_PROTOCOL_ERROR and is not replayed', async () => {
  const host = await startFakeHost((_req, socket) => socket.write('not json\n'));
  allowRelay();
  const tools = loadTools();
  try {
    await assert.rejects(
      () => tools['chrome_fill'].execute('c1', { tabId: 7, selector: '#q', value: 'x' }, undefined),
      { message: /^NATIVE_IPC_PROTOCOL_ERROR: .*unparseable/ },
    );
    assert.equal(host.requests.length, 1);
    assert.deepEqual(relayCalls, []);
  } finally {
    await host.close();
  }
});

for (const answer of ['null', '[]', '42', '"ok"', 'true']) {
  test(`a JSON answer that is not an object (${answer}) is a protocol error, not a response`, async () => {
    await startFakeHost((_req, socket) => socket.write(answer + '\n'));
    await assert.rejects(
      () => loadTools()['chrome_query_tabs'].execute('c1', {}, undefined),
      { message: /^NATIVE_IPC_PROTOCOL_ERROR: .*not a JSON object.*not retried/ },
    );
  });
}

test('a host that exits mid-request fails fast with NATIVE_IPC_PROTOCOL_ERROR instead of waiting out the timeout', async () => {
  const host = await startFakeHost((_req, socket) => socket.end());
  allowRelay();
  const tools = loadTools();
  const started = Date.now();
  try {
    await assert.rejects(
      () => tools['chrome_create_tab'].execute('c1', { url: 'https://example.com' }, undefined),
      /NATIVE_IPC_PROTOCOL_ERROR: .*closed the connection without answering/,
    );
    assert.ok(Date.now() - started < IPC_TIMEOUT_MS / 2, `took ${Date.now() - started}ms; the close must be noticed immediately`);
    assert.deepEqual(relayCalls, [], 'createTab must not run twice');
  } finally {
    await host.close();
  }
});

test('a partial answer followed by a close is a protocol error', async () => {
  const host = await startFakeHost((_req, socket) => socket.end('{"success":tr'));
  const tools = loadTools();
  try {
    await assert.rejects(
      () => tools['chrome_query_tabs'].execute('c1', {}, undefined),
      /NATIVE_IPC_PROTOCOL_ERROR/,
    );
  } finally {
    await host.close();
  }
});

test('an answer followed immediately by the host closing is still delivered', async () => {
  await startFakeHost((_req, socket) => socket.end('{"success":true,"result":"last words"}\n'));
  const result = parsed(await loadTools()['chrome_query_tabs'].execute('c1', { mode: 'full' }, undefined));
  assert.equal(result.result, 'last words');
});

test('only the first answer line counts when two arrive in one read', async () => {
  await startFakeHost((_req, socket) => socket.write('{"success":true,"result":"first"}\n{"success":true,"result":"second"}\n'));
  const result = parsed(await loadTools()['chrome_query_tabs'].execute('c1', { mode: 'full' }, undefined));
  assert.equal(result.result, 'first');
});

test('a connection dropped while the request is still being written is a protocol error', async () => {
  // The host stops reading and drops the socket while a large request is
  // still in flight, so the client's write fails after connect (EPIPE/ECONNRESET).
  const socketPath = path.join(tmpDir, 'reset.sock');
  const server = net.createServer({ pauseOnConnect: true }, (socket) => {
    socket.on('error', () => {});
    setTimeout(() => socket.destroy(), 20);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  process.env.CHROME_CONTROLLER_SOCKET = socketPath;
  allowRelay();
  const tools = loadTools();
  try {
    await assert.rejects(
      () => tools['chrome_type_text'].execute('c1', { tabId: 1, text: 'x'.repeat(8 * 1024 * 1024) }, undefined),
      (err: Error) => {
        assert.match(err.message, /^NATIVE_IPC_PROTOCOL_ERROR: .*connection failed after the request was sent \(.*(EPIPE|ECONNRESET)/);
        return true;
      },
    );
    assert.deepEqual(relayCalls, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ── Successful round-trips ───────────────────────────────────────────────────

test('after an answer the client closes its side and leaves no timer running', async () => {
  const host = await startFakeHost((_req, socket) => socket.write('{"success":true,"result":[]}\n'));
  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  await loadTools()['chrome_query_tabs'].execute('c1', {}, undefined);
  // The real host never closes first, so a client that skips end() leaks a socket per call.
  for (let i = 0; i < 50 && host.clientEnds() === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(host.clientEnds(), 1);
  const timersAfter = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  assert.equal(timersAfter, timersBefore, `the ${IPC_TIMEOUT_MS}ms IPC timer must be cleared on success`);
});

test('a multi-megabyte answer is read well within the timeout', async () => {
  // Rescanning the whole buffer per 8 KB read is quadratic: 16 MB took ~9 s,
  // enough to be misreported as a wedged host.
  const frame = 'A'.repeat(16 * 1024 * 1024);
  await startFakeHost((_req, socket) => socket.write(JSON.stringify({ success: true, result: frame }) + '\n'));
  const tools: Record<string, Tool> = {};
  const pi = { registerTool: (tool: Tool & { name: string }) => { tools[tool.name] = tool; } };
  chromeControllerPiExtension(pi as unknown as ExtensionAPI, { ipcTimeoutMs: 3000 });
  const started = Date.now();
  const result = parsed(await tools['chrome_query_tabs'].execute('c1', { mode: 'full' }, undefined));
  assert.equal((result.result as string).length, frame.length);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
});

test('host answers are returned as-is, including success:false, without using the relay', async () => {
  const host = await startFakeHost((req, socket) => {
    if (req.action === 'createTab') socket.write(JSON.stringify({ success: false, error: 'The extensions gallery cannot be scripted.' }) + '\n');
    else socket.write(JSON.stringify({ success: true, result: [{ id: 3, title: 't', url: 'u', active: true, windowId: 1, extra: 1 }] }) + '\n');
  });
  allowRelay();
  const tools = loadTools();
  try {
    const rejected = parsed(await tools['chrome_create_tab'].execute('c1', { url: 'https://chromewebstore.google.com' }, undefined));
    assert.deepEqual(rejected, { success: false, error: 'The extensions gallery cannot be scripted.' });
    const tabs = parsed(await tools['chrome_query_tabs'].execute('c2', {}, undefined));
    assert.deepEqual(tabs.result, [{ id: 3, title: 't', url: 'u', active: true, windowId: 1 }]);
    assert.deepEqual(host.requests.map((r) => r.action), ['createTab', 'queryTabs']);
    assert.deepEqual(relayCalls, []);
  } finally {
    await host.close();
  }
});

test('a multi-byte character split across two reads is decoded intact', async () => {
  const title = 'Привет 🌍 世界';
  const host = await startFakeHost((_req, socket) => {
    const bytes = Buffer.from(JSON.stringify({ success: true, result: [{ id: 1, title }] }) + '\n', 'utf8');
    // Split inside the 4-byte emoji so neither half is valid UTF-8 on its own.
    const split = bytes.indexOf(Buffer.from('🌍', 'utf8')) + 2;
    socket.write(bytes.subarray(0, split));
    setTimeout(() => socket.write(bytes.subarray(split)), 30);
  });
  const tools = loadTools();
  try {
    const result = parsed(await tools['chrome_query_tabs'].execute('c1', { mode: 'full' }, undefined));
    assert.deepEqual(result.result, [{ id: 1, title }]);
  } finally {
    await host.close();
  }
});

test('an answer delivered in several chunks is only parsed once the newline arrives', async () => {
  const host = await startFakeHost((_req, socket) => {
    socket.write('{"success":true,');
    setTimeout(() => socket.write('"result":"ok"}'), 20);
    setTimeout(() => socket.write('\n'), 40);
  });
  const tools = loadTools();
  try {
    const result = parsed(await tools['chrome_query_tabs'].execute('c1', { mode: 'full' }, undefined));
    assert.equal(result.result, 'ok');
  } finally {
    await host.close();
  }
});

test('CHROME_CONTROLLER_URL skips IPC entirely even when a host is listening', async () => {
  const host = await startFakeHost((_req, socket) => socket.write('{"success":true,"result":"from-ipc"}\n'));
  process.env.CHROME_CONTROLLER_URL = 'http://127.0.0.1:8898';
  process.env.CHROME_CONTROLLER_API_KEY = TEST_API_KEY;
  const tools = loadTools();
  try {
    const result = parsed(await tools['chrome_query_tabs'].execute('c1', { mode: 'full' }, undefined));
    assert.equal(result.result, 'from-relay');
    assert.equal(host.requests.length, 0);
  } finally {
    await host.close();
  }
});

// ── Health ───────────────────────────────────────────────────────────────────

test('health reports NativeMessagingIPC when the host answers queryTabs', async () => {
  const host = await startFakeHost((_req, socket) => socket.write('{"success":true,"result":[]}\n'));
  const tools = loadTools();
  try {
    const result = parsed(await tools['chrome_controller_health'].execute('c1', {}, undefined));
    assert.deepEqual(result, { success: true, extensionConnected: true, mode: 'NativeMessagingIPC' });
    assert.deepEqual(relayCalls, []);
  } finally {
    await host.close();
  }
});

function refusingHost(pong: unknown) {
  return startFakeHost((req, socket) => {
    if (req.action === 'hostPing') socket.write(JSON.stringify(pong) + '\n');
    else socket.write(JSON.stringify({ success: false, error: 'Browser output is locked during guarded extraction' }) + '\n');
  });
}

test('health with a host refusing queryTabs reports the host state from hostPing instead of consulting the relay', async () => {
  const host = await refusingHost({
    success: true,
    result: { pong: true, chromeConnected: true, sensitiveExtractionInProgress: true, browserOutputQuarantined: false },
  });
  const result = parsed(await loadTools()['chrome_controller_health'].execute('c1', {}, undefined));
  assert.deepEqual(result, {
    success: false,
    mode: 'NativeMessagingIPC',
    error: 'Browser output is locked during guarded extraction',
    extensionConnected: true,
    sensitiveExtractionInProgress: true,
    browserOutputQuarantined: false,
  });
  assert.deepEqual(host.requests.map((r) => r.action), ['queryTabs', 'hostPing']);
  assert.deepEqual(relayCalls, [], 'no relay is configured, and none may be consulted');
});

test('health with a refusing host does not switch to the relay even when allowed', async () => {
  await refusingHost({ success: true, result: { chromeConnected: false } });
  allowRelay();
  const result = parsed(await loadTools()['chrome_controller_health'].execute('c1', {}, undefined));
  assert.equal(result.mode, 'NativeMessagingIPC');
  assert.equal(result.extensionConnected, false);
  assert.equal(result.browserOutputQuarantined, false);
  assert.deepEqual(relayCalls, []);
});

for (const [label, pong] of [['refuses', { success: false }], ['answers without a result', { success: true }]] as const) {
  test(`health omits host state when hostPing ${label}`, async () => {
    await refusingHost(pong);
    const result = parsed(await loadTools()['chrome_controller_health'].execute('c1', {}, undefined));
    assert.deepEqual(result, { success: false, mode: 'NativeMessagingIPC', error: 'Browser output is locked during guarded extraction' });
  });
}

test('health omits host state when hostPing itself fails, and names a default error', async () => {
  await startFakeHost((req, socket) => {
    if (req.action === 'hostPing') socket.destroy();
    else socket.write('{"success":false}\n');
  });
  const result = parsed(await loadTools()['chrome_controller_health'].execute('c1', {}, undefined));
  assert.deepEqual(result, { success: false, mode: 'NativeMessagingIPC', error: 'Native host answered queryTabs with success:false' });
});

test('health on a wedged host reports NATIVE_IPC_TIMEOUT rather than the relay state', async () => {
  const host = await startFakeHost(() => {});
  allowRelay();
  const tools = loadTools();
  try {
    await assert.rejects(() => tools['chrome_controller_health'].execute('c1', {}, undefined), /NATIVE_IPC_TIMEOUT/);
    assert.deepEqual(relayCalls, []);
  } finally {
    await host.close();
  }
});

test('health with no host falls back to the relay /health only when allowed', async () => {
  process.env.CHROME_CONTROLLER_SOCKET = path.join(tmpDir, 'missing.sock');
  await assert.rejects(() => loadTools()['chrome_controller_health'].execute('c1', {}, undefined), { message: /^NATIVE_IPC_UNAVAILABLE: / });
  assert.deepEqual(relayCalls, []);

  allowRelay();
  const result = parsed(await loadTools()['chrome_controller_health'].execute('c2', {}, undefined));
  assert.equal(result.extensionConnected, true);
  assert.deepEqual(relayCalls, ['http://127.0.0.1:8898/health']);
});

// ── Abort and option validation ──────────────────────────────────────────────

test('an already-aborted call never reaches the host or the relay', async () => {
  const host = await startFakeHost((_req, socket) => socket.write('{"success":true}\n'));
  allowRelay();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => loadTools()['chrome_click'].execute('c1', { tabId: 7, selector: '#buy' }, controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(host.requests.length, 0);
  assert.deepEqual(relayCalls, []);
});

test('an abort mid-request rejects at once and is not replayed over the relay', async () => {
  const host = await startFakeHost(() => { /* never answer */ });
  allowRelay();
  const controller = new AbortController();
  const started = Date.now();
  const pending = loadTools()['chrome_click'].execute('c1', { tabId: 7, selector: '#buy' }, controller.signal);
  while (host.requests.length === 0) await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(Date.now() - started < IPC_TIMEOUT_MS, 'must not wait out the IPC timeout');
  assert.deepEqual(relayCalls, []);
});

test('an invalid ipcTimeoutMs is rejected when the extension loads', () => {
  const pi = { registerTool: () => {} } as unknown as ExtensionAPI;
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
    assert.throws(() => chromeControllerPiExtension(pi, { ipcTimeoutMs: bad }), RangeError, String(bad));
  }
  assert.doesNotThrow(() => chromeControllerPiExtension(pi, { ipcTimeoutMs: 2 ** 31 - 1 }));
});
