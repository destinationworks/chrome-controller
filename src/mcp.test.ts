/**
 * Unit tests for the MCP server (src/mcp.ts).
 *
 * Run: npx tsx --test src/mcp.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readDiscovery,
  getConfig,
  sendCommand,
  buildHealthReport,
  HOST_STATE_REMEDIATION,
  HEALTH_PROBE_TIMEOUT_MS,
  HEALTH_CHROME_WAIT_MS,
  HostRejectedError,
  type IpcError,
} from './mcp.js';
import { removeDiscovery, writeDiscovery } from './discovery.js';
import { spawn } from 'node:child_process';
import { createChromeControllerServer } from './server.js';
import { WebSocket } from 'ws';
import { setEnv, startLargeAnswerHost, startScriptedChrome } from '../test/scripted-chrome.ts';

const TEST_API_KEY = 'test-key-0123456789abcdef01234567';

function testDiscovery(httpPort: number, apiKey = TEST_API_KEY) {
  return {
    httpPort,
    wsPort: httpPort === 65535 ? 65534 : httpPort + 1,
    apiKey,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

// ── readDiscovery tests ──────────────────────────────────────────────────────

test('readDiscovery returns null for non-existent file', () => {
  const result = readDiscovery('nonexistent-instance');
  assert.strictEqual(result, null);
});

test('readDiscovery returns parsed data for valid file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  const instancePath = path.join(tmpDir, 'test-discovery.json');
  const discoveryData = testDiscovery(9999);
  fs.writeFileSync(instancePath, JSON.stringify(discoveryData));

  // Monkey-patch DISCOVERY_DIR indirectly: we can't, so write to actual ~/.chrome-controller
  const testInstance = 'mcp-test-' + process.pid + '-' + Date.now();
  writeDiscovery(testInstance, discoveryData);

  try {
    const result = readDiscovery(testInstance);
    assert.deepStrictEqual(result, discoveryData);
  } finally {
    removeDiscovery(testInstance);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readDiscovery returns null for malformed JSON', () => {
  const testInstance = 'mcp-test-malformed-' + process.pid + '-' + Date.now();
  const discoveryDir = path.join(os.homedir(), '.chrome-controller');
  fs.mkdirSync(discoveryDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(discoveryDir, `${testInstance}.json`), 'not-json{{{', { mode: 0o600 });

  try {
    const result = readDiscovery(testInstance);
    assert.strictEqual(result, null);
  } finally {
    fs.rmSync(path.join(discoveryDir, `${testInstance}.json`), { force: true });
  }
});

// ── getConfig tests ─────────────────────────────────────────────────────────

test('getConfig fails closed when no env or private discovery exists', () => {
  const origHttpPort = process.env.HTTP_PORT;
  const origApiKey = process.env.API_KEY;
  const origInstance = process.env.CHROME_CONTROLLER_INSTANCE;

  delete process.env.HTTP_PORT;
  delete process.env.API_KEY;
  process.env.CHROME_CONTROLLER_INSTANCE = 'mcp-test-no-discovery-' + process.pid + '-' + Date.now();

  try {
    assert.throws(() => getConfig(), /RELAY_CONFIG_UNAVAILABLE/);
  } finally {
    if (origHttpPort !== undefined) process.env.HTTP_PORT = origHttpPort;
    else delete process.env.HTTP_PORT;
    if (origApiKey !== undefined) process.env.API_KEY = origApiKey;
    else delete process.env.API_KEY;
    if (origInstance !== undefined) process.env.CHROME_CONTROLLER_INSTANCE = origInstance;
    else delete process.env.CHROME_CONTROLLER_INSTANCE;
  }
});

test('getConfig uses explicit HTTP_PORT and API_KEY env vars', () => {
  const origHttpPort = process.env.HTTP_PORT;
  const origApiKey = process.env.API_KEY;

  process.env.HTTP_PORT = '12345';
  process.env.API_KEY = TEST_API_KEY;

  try {
    const config = getConfig();
    assert.strictEqual(config.httpPort, 12345);
    assert.strictEqual(config.apiKey, TEST_API_KEY);
  } finally {
    if (origHttpPort !== undefined) process.env.HTTP_PORT = origHttpPort;
    else delete process.env.HTTP_PORT;
    if (origApiKey !== undefined) process.env.API_KEY = origApiKey;
    else delete process.env.API_KEY;
  }
});

test('getConfig rejects HTTP_PORT without API_KEY or matching discovery', () => {
  const origHttpPort = process.env.HTTP_PORT;
  const origApiKey = process.env.API_KEY;
  const origInstance = process.env.CHROME_CONTROLLER_INSTANCE;

  process.env.HTTP_PORT = '5555';
  delete process.env.API_KEY;
  process.env.CHROME_CONTROLLER_INSTANCE = 'mcp-test-partial-' + process.pid + '-' + Date.now();

  try {
    assert.throws(() => getConfig(), /RELAY_CONFIG_UNAVAILABLE/);
  } finally {
    if (origHttpPort !== undefined) process.env.HTTP_PORT = origHttpPort;
    else delete process.env.HTTP_PORT;
    if (origApiKey !== undefined) process.env.API_KEY = origApiKey;
    else delete process.env.API_KEY;
    if (origInstance !== undefined) process.env.CHROME_CONTROLLER_INSTANCE = origInstance;
    else delete process.env.CHROME_CONTROLLER_INSTANCE;
  }
});

test('getConfig reads from discovery file for default instance', () => {
  const origHttpPort = process.env.HTTP_PORT;
  const origApiKey = process.env.API_KEY;
  const origInstance = process.env.CHROME_CONTROLLER_INSTANCE;

  delete process.env.HTTP_PORT;
  delete process.env.API_KEY;
  process.env.CHROME_CONTROLLER_INSTANCE = 'mcp-test-default-' + process.pid + '-' + Date.now();

  writeDiscovery(process.env.CHROME_CONTROLLER_INSTANCE, testDiscovery(7777));

  try {
    const config = getConfig();
    assert.strictEqual(config.httpPort, 7777);
    assert.strictEqual(config.apiKey, TEST_API_KEY);
  } finally {
    removeDiscovery(process.env.CHROME_CONTROLLER_INSTANCE);
    if (origHttpPort !== undefined) process.env.HTTP_PORT = origHttpPort;
    else delete process.env.HTTP_PORT;
    if (origApiKey !== undefined) process.env.API_KEY = origApiKey;
    else delete process.env.API_KEY;
    if (origInstance !== undefined) process.env.CHROME_CONTROLLER_INSTANCE = origInstance;
    else delete process.env.CHROME_CONTROLLER_INSTANCE;
  }
});

// ── sendCommand tests ────────────────────────────────────────────────────────

// sendCommand connection-refused test skipped: macOS sometimes does not
// return ECONNREFUSED promptly for arbitrary high ports, causing test hangs.

test('sendCommand sends correct action and params to server', async () => {
  const origApiKey = process.env.API_KEY;
  const origHttpPort = process.env.HTTP_PORT;
  const origInstance = process.env.CHROME_CONTROLLER_INSTANCE;
  const origSocket = process.env.CHROME_CONTROLLER_SOCKET;

  delete process.env.CHROME_CONTROLLER_INSTANCE;
  // HTTP_PORT should bypass IPC; if routing regresses, fail here rather than
  // reaching a developer's live native host.
  process.env.CHROME_CONTROLLER_SOCKET = path.join(os.tmpdir(), `mcp-no-host-${process.pid}.sock`);

  // Spin up a tiny HTTP server to capture the request
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.strictEqual(parsed.action, 'queryTabs');
      assert.strictEqual(parsed.url, 'https://example.com');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { tabs: [] } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  process.env.HTTP_PORT = String(port);
  process.env.API_KEY = TEST_API_KEY;

  try {
    const result = await sendCommand('queryTabs', { url: 'https://example.com' });
    assert.deepStrictEqual(result, { tabs: [] });
  } finally {
    server.close();
    if (origHttpPort !== undefined) process.env.HTTP_PORT = origHttpPort;
    else delete process.env.HTTP_PORT;
    if (origApiKey !== undefined) process.env.API_KEY = origApiKey;
    else delete process.env.API_KEY;
    if (origInstance !== undefined) process.env.CHROME_CONTROLLER_INSTANCE = origInstance;
    else delete process.env.CHROME_CONTROLLER_INSTANCE;
    if (origSocket !== undefined) process.env.CHROME_CONTROLLER_SOCKET = origSocket;
    else delete process.env.CHROME_CONTROLLER_SOCKET;
  }
});

test('sendCommand rejects when server returns error response', async () => {
  const origApiKey = process.env.API_KEY;
  const origHttpPort = process.env.HTTP_PORT;
  const origInstance = process.env.CHROME_CONTROLLER_INSTANCE;
  const origSocket = process.env.CHROME_CONTROLLER_SOCKET;

  delete process.env.CHROME_CONTROLLER_INSTANCE;
  // HTTP_PORT should bypass IPC; if routing regresses, fail here rather than
  // reaching a developer's live native host.
  process.env.CHROME_CONTROLLER_SOCKET = path.join(os.tmpdir(), `mcp-no-host-${process.pid}.sock`);

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'something broke' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  process.env.HTTP_PORT = String(port);
  process.env.API_KEY = TEST_API_KEY;

  try {
    await assert.rejects(
      () => sendCommand('queryTabs'),
      (err: Error) => {
        assert.strictEqual(err.message, 'something broke');
        return true;
      }
    );
  } finally {
    server.close();
    if (origHttpPort !== undefined) process.env.HTTP_PORT = origHttpPort;
    else delete process.env.HTTP_PORT;
    if (origApiKey !== undefined) process.env.API_KEY = origApiKey;
    else delete process.env.API_KEY;
    if (origInstance !== undefined) process.env.CHROME_CONTROLLER_INSTANCE = origInstance;
    else delete process.env.CHROME_CONTROLLER_INSTANCE;
    if (origSocket !== undefined) process.env.CHROME_CONTROLLER_SOCKET = origSocket;
    else delete process.env.CHROME_CONTROLLER_SOCKET;
  }
});

test('sendCommand fails closed with NATIVE_IPC_UNAVAILABLE when IPC is down and relay is disabled', async () => {
  const origHttpPort = process.env.HTTP_PORT;
  const origAllowRelay = process.env.CHROME_CONTROLLER_ALLOW_RELAY;
  const origSocket = process.env.CHROME_CONTROLLER_SOCKET;

  delete process.env.HTTP_PORT;
  delete process.env.CHROME_CONTROLLER_ALLOW_RELAY;
  process.env.CHROME_CONTROLLER_SOCKET = '/tmp/nonexistent-socket-' + Date.now() + '.sock';

  try {
    await assert.rejects(
      () => sendCommand('queryTabs'),
      (err: Error) => {
        assert.ok(err.message.includes('NATIVE_IPC_UNAVAILABLE'));
        return true;
      }
    );
  } finally {
    if (origHttpPort !== undefined) process.env.HTTP_PORT = origHttpPort;
    else delete process.env.HTTP_PORT;
    if (origAllowRelay !== undefined) process.env.CHROME_CONTROLLER_ALLOW_RELAY = origAllowRelay;
    else delete process.env.CHROME_CONTROLLER_ALLOW_RELAY;
    if (origSocket !== undefined) process.env.CHROME_CONTROLLER_SOCKET = origSocket;
    else delete process.env.CHROME_CONTROLLER_SOCKET;
  }
});

test('sendCommand executes successfully over Native Messaging IPC socket', async () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ipc-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const origSocket = process.env.CHROME_CONTROLLER_SOCKET;
  process.env.CHROME_CONTROLLER_SOCKET = testSocket;

  const server = net.createServer((client) => {
    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('\n')) {
        const parsed = JSON.parse(buf.trim());
        client.write(JSON.stringify({ success: true, result: { echo: parsed.action, tabs: [{ id: 42 }] } }) + '\n');
        client.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(testSocket, () => resolve()));

  try {
    const result = await sendCommand('queryTabs', { url: 'https://ipc.test' });
    assert.deepStrictEqual(result, { echo: 'queryTabs', tabs: [{ id: 42 }] });
  } finally {
    server.close();
    if (origSocket !== undefined) process.env.CHROME_CONTROLLER_SOCKET = origSocket;
    else delete process.env.CHROME_CONTROLLER_SOCKET;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('sendCommand dispatches getConsoleLogs and cleanupManagedTabs over IPC', async () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ipc-actions-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const origSocket = process.env.CHROME_CONTROLLER_SOCKET;
  process.env.CHROME_CONTROLLER_SOCKET = testSocket;

  let lastAction = '';
  let lastParams: any = null;

  const server = net.createServer((client) => {
    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('\n')) {
        const parsed = JSON.parse(buf.trim());
        lastAction = parsed.action;
        lastParams = parsed;
        client.write(JSON.stringify({ success: true, result: { handled: parsed.action } }) + '\n');
        client.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(testSocket, () => resolve()));

  try {
    const logsResult = await sendCommand('getConsoleLogs', { tabId: 10, timeoutMs: 1500 });
    assert.strictEqual(lastAction, 'getConsoleLogs');
    assert.strictEqual(lastParams.timeoutMs, 1500);
    assert.deepStrictEqual(logsResult, { handled: 'getConsoleLogs' });

    const cleanupResult = await sendCommand('cleanupManagedTabs', { closeTabs: true, windowId: 5 });
    assert.strictEqual(lastAction, 'cleanupManagedTabs');
    assert.strictEqual(lastParams.closeTabs, true);
    assert.strictEqual(lastParams.windowId, 5);
    assert.deepStrictEqual(cleanupResult, { handled: 'cleanupManagedTabs' });
  } finally {
    server.close();
    if (origSocket !== undefined) process.env.CHROME_CONTROLLER_SOCKET = origSocket;
    else delete process.env.CHROME_CONTROLLER_SOCKET;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

// ── IPC failure classification ───────────────────────────────────────────────
//
// sendCommand's IPC path rejects for different reasons that need different answers:
// a request that never reached the host (unavailable, safe to relay), a host
// that got the request but did not answer (timeout / protocol, outcome
// unknown), and a host that answered { success: false } (the real result).

// A regression that stops the client timer would otherwise hang CI instead of failing it.
const IPC_TEST = { timeout: 15_000 };

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(overrides);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

function tmpSocketDir(prefix: string): { dir: string; socket: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, socket: path.join(dir, 'h.sock') };
}

/** Resolves true once `closed` settles, or false after `ms`. */
async function settlesWithin(closed: Promise<void> | undefined, ms: number): Promise<boolean> {
  if (!closed) return false;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([closed.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A fake native host: parses newline-framed requests and lets each test decide
 * how to answer. `disconnects[i]` settles when connection i is closed, which
 * lets tests prove the client releases its socket (the real host never closes
 * a connection itself, so a client that forgets to would leak one per call).
 */
async function startFakeHost(
  onRequest: (client: net.Socket, request: Record<string, unknown>) => void,
): Promise<{ socket: string; requests: Record<string, unknown>[]; disconnects: Promise<void>[]; close: () => Promise<void> }> {
  const { dir, socket } = tmpSocketDir('mcp-host-');
  const requests: Record<string, unknown>[] = [];
  const disconnects: Promise<void>[] = [];
  const clients = new Set<net.Socket>();
  const server = net.createServer((client) => {
    clients.add(client);
    disconnects.push(new Promise<void>((resolve) => client.once('close', () => resolve())));
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      buffer = buffer.slice(newline + 1);
      requests.push(request);
      onRequest(client, request);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  return {
    socket,
    requests,
    disconnects,
    close: async () => {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fake HTTP relay reachable only through a private discovery file, so HTTP_PORT stays unset and IPC is tried first. */
async function startFakeRelay(): Promise<{ instance: string; port: number; hits: Record<string, unknown>[]; close: () => Promise<void> }> {
  const hits: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      hits.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { via: 'relay' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  const instance = `mcp-test-relay-${process.pid}-${Date.now()}`;
  writeDiscovery(instance, testDiscovery(port));
  return {
    instance,
    port,
    hits,
    close: async () => {
      removeDiscovery(instance);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function relayAllowedEnv(socket: string, instance: string): Record<string, string | undefined> {
  return {
    CHROME_CONTROLLER_SOCKET: socket,
    CHROME_CONTROLLER_ALLOW_RELAY: '1',
    CHROME_CONTROLLER_INSTANCE: instance,
    HTTP_PORT: undefined,
    API_KEY: undefined,
  };
}

/** A socket file whose listener was SIGKILLed, so connecting to it is refused (ECONNREFUSED). */
async function makeStaleSocket(): Promise<{ socket: string; cleanup: () => void }> {
  const { dir, socket } = tmpSocketDir('mcp-stale-');
  const child = spawn(process.execPath, [
    '-e',
    `require('net').createServer(()=>{}).listen(${JSON.stringify(socket)}, () => console.log('up'))`,
  ]);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d) => { if (d.toString().includes('up')) resolve(); });
    child.on('error', reject);
    child.once('exit', (code) => reject(new Error(`stale-socket fixture exited before binding (code ${code})`)));
  });
  child.kill('SIGKILL');
  await exited;
  assert.ok(fs.existsSync(socket), 'SIGKILL must leave the socket file behind');
  return { socket, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const NOT_RETRIED = /may still have run in Chrome, so it was not retried/;

test('sendCommand surfaces an application error from the host verbatim instead of NATIVE_IPC_UNAVAILABLE', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  // Both are answers the host really sends: the first is Chrome refusing to
  // script the Web Store, the second is the host giving up on Chrome.
  const hostErrors = [
    'The extensions gallery cannot be scripted.',
    'Native Messaging request timed out after 15000ms',
  ];
  for (const hostError of hostErrors) {
    const host = await startFakeHost((client) => {
      client.write(JSON.stringify({ success: false, error: hostError }) + '\n');
    });
    const relay = await startFakeRelay();
    try {
      await withEnv(relayAllowedEnv(host.socket, relay.instance), async () => {
        await assert.rejects(
          () => sendCommand('evaluateOnPage', { tabId: 7 }),
          (err: IpcError) => {
            assert.strictEqual(err.message, hostError, 'the host answer is the result and must not be rewrapped');
            assert.strictEqual(err.kind, 'rejected');
            return true;
          },
        );
      });
      assert.strictEqual(host.requests.length, 1);
      assert.strictEqual(relay.hits.length, 0, 'an answered request must not be retried over the relay');
    } finally {
      await host.close();
      await relay.close();
    }
  }
});

test('sendCommand labels a client-side timeout NATIVE_IPC_TIMEOUT, points at the watchdog, and releases the socket', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  // Accepts the request and never answers: what a wedged host, or a host
  // still waiting on a slow Chrome, looks like from the client.
  const host = await startFakeHost(() => {});
  const relay = await startFakeRelay();
  try {
    await withEnv(relayAllowedEnv(host.socket, relay.instance), async () => {
      await assert.rejects(
        () => sendCommand('clickSelector', { tabId: 7, selector: '#go' }, 1000),
        (err: IpcError) => {
          assert.strictEqual(err.kind, 'timeout');
          assert.match(err.message, /^NATIVE_IPC_TIMEOUT: /);
          assert.ok(err.message.includes(host.socket));
          assert.match(err.message, /did not answer within 1000ms/);
          assert.match(err.message, /npm run watchdog/);
          assert.match(err.message, NOT_RETRIED);
          assert.doesNotMatch(err.message, /NATIVE_IPC_UNAVAILABLE/);
          return true;
        },
      );
    });
    assert.strictEqual(host.requests.length, 1, 'the request did reach the host');
    assert.strictEqual(relay.hits.length, 0, 'a request the host may still execute must not be replayed over the relay');
    assert.ok(await settlesWithin(host.disconnects[0], 1000), 'a timed-out client must close its connection to a wedged host');
  } finally {
    await host.close();
    await relay.close();
  }
});

test('sendCommand closes its connection after a successful answer', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  // The real host answers and keeps the connection open, so the client must close it.
  const host = await startFakeHost((client) => {
    client.write(JSON.stringify({ success: true, result: { ok: 1 } }) + '\n');
  });
  try {
    await withEnv({ CHROME_CONTROLLER_SOCKET: host.socket, HTTP_PORT: undefined }, async () => {
      assert.deepStrictEqual(await sendCommand('queryTabs'), { ok: 1 });
    });
    assert.ok(await settlesWithin(host.disconnects[0], 1000), 'the client must not leak one socket per call');
  } finally {
    await host.close();
  }
});

test('sendCommand reports a host that closes the connection without answering, without waiting for the timeout', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const host = await startFakeHost((client) => client.end());
  const relay = await startFakeRelay();
  try {
    await withEnv(relayAllowedEnv(host.socket, relay.instance), async () => {
      const started = Date.now();
      await assert.rejects(
        () => sendCommand('queryTabs', {}, 5000),
        (err: IpcError) => {
          assert.strictEqual(err.kind, 'protocol', 'a closed connection is not a timeout');
          assert.match(err.message, /^NATIVE_IPC_PROTOCOL_ERROR: /);
          assert.match(err.message, /closed the connection without answering/);
          assert.match(err.message, /npm run watchdog/);
          assert.match(err.message, NOT_RETRIED);
          return true;
        },
      );
      assert.ok(Date.now() - started < 2500, 'must fail when the connection closes, not when the 5000ms timer fires');
    });
    assert.strictEqual(relay.hits.length, 0);
  } finally {
    await host.close();
    await relay.close();
  }
});

test('sendCommand reports a truncated answer followed by a close as a protocol error, not a timeout', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const host = await startFakeHost((client) => client.end('{"success":true,"res'));
  const relay = await startFakeRelay();
  try {
    await withEnv(relayAllowedEnv(host.socket, relay.instance), async () => {
      const started = Date.now();
      await assert.rejects(
        () => sendCommand('queryTabs', {}, 5000),
        (err: IpcError) => {
          assert.strictEqual(err.kind, 'protocol');
          assert.match(err.message, /closed the connection without answering/);
          assert.match(err.message, NOT_RETRIED);
          return true;
        },
      );
      assert.ok(Date.now() - started < 2500, 'must fail when the connection closes, not when the 5000ms timer fires');
    });
    assert.strictEqual(relay.hits.length, 0);
  } finally {
    await host.close();
    await relay.close();
  }
});

test('sendCommand reports an unparseable host answer as a protocol error and does not relay it', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const host = await startFakeHost((client) => client.write('not json at all\n'));
  const relay = await startFakeRelay();
  try {
    await withEnv(relayAllowedEnv(host.socket, relay.instance), async () => {
      await assert.rejects(
        () => sendCommand('queryTabs', {}, 2000),
        (err: IpcError) => {
          assert.strictEqual(err.kind, 'protocol');
          assert.match(err.message, /^NATIVE_IPC_PROTOCOL_ERROR: /);
          assert.match(err.message, /unparseable response/);
          assert.match(err.message, NOT_RETRIED);
          return true;
        },
      );
    });
    assert.strictEqual(relay.hits.length, 0);
  } finally {
    await host.close();
    await relay.close();
  }
});

test('sendCommand reports valid JSON that is not a host answer as a protocol error instead of crashing', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  // `null` used to throw inside the data handler (reading `.success` of null),
  // crashing the MCP server; `42` and `{}` were reported as host rejections.
  for (const line of ['null', '42', '{}', '"ok"', '[]']) {
    const host = await startFakeHost((client) => client.write(line + '\n'));
    try {
      await withEnv({ CHROME_CONTROLLER_SOCKET: host.socket, HTTP_PORT: undefined }, async () => {
        await assert.rejects(
          () => sendCommand('queryTabs', {}, 2000),
          (err: IpcError) => {
            assert.strictEqual(err.kind, 'protocol', `${line} is not an answer`);
            assert.match(err.message, /returned a malformed response/);
            return true;
          },
        );
      });
    } finally {
      await host.close();
    }
  }
});

test('sendCommand gives a host rejection without an error string a generic message', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  for (const answer of [{ success: false }, { success: false, error: { code: 1 } }]) {
    const host = await startFakeHost((client) => client.write(JSON.stringify(answer) + '\n'));
    try {
      await withEnv({ CHROME_CONTROLLER_SOCKET: host.socket, HTTP_PORT: undefined }, async () => {
        await assert.rejects(
          () => sendCommand('queryTabs', {}, 2000),
          (err: IpcError) => {
            assert.strictEqual(err.kind, 'rejected');
            assert.strictEqual(err.message, 'IPC command failed');
            return true;
          },
        );
      });
    } finally {
      await host.close();
    }
  }
});

test('sendCommand treats a socket error after connecting as a protocol error, not as unavailable', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  // A host that stops reading and drops the client (as it does for an
  // oversized line, or when it dies mid-request). The request is larger than
  // the socket buffer, so the pending write fails with EPIPE/ECONNRESET after
  // the connection was established. The host may have read part of it, so
  // this must not be mistaken for "never reached the host" and relayed.
  const { dir, socket } = tmpSocketDir('mcp-epipe-');
  const server = net.createServer({ pauseOnConnect: true }, (client) => {
    setTimeout(() => client.destroy(), 30);
  });
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  const relay = await startFakeRelay();
  try {
    await withEnv(relayAllowedEnv(socket, relay.instance), async () => {
      await assert.rejects(
        () => sendCommand('evaluateOnPage', { tabId: 7, expression: 'x'.repeat(1024 * 1024) }, 5000),
        (err: IpcError) => {
          assert.strictEqual(err.kind, 'protocol');
          assert.match(err.message, /^NATIVE_IPC_PROTOCOL_ERROR: /);
          assert.match(err.message, /connection failed after the request was sent \(.*(EPIPE|ECONNRESET)/);
          assert.match(err.message, NOT_RETRIED);
          return true;
        },
      );
    });
    assert.strictEqual(relay.hits.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
    await relay.close();
  }
});

test('sendCommand keeps NATIVE_IPC_UNAVAILABLE for transport failures and says why', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const stale = await makeStaleSocket();
  const missing = path.join(os.tmpdir(), `mcp-missing-${process.pid}-${Date.now()}.sock`);
  try {
    for (const [socket, code] of [[missing, 'ENOENT'], [stale.socket, 'ECONNREFUSED']] as const) {
      await withEnv({ CHROME_CONTROLLER_SOCKET: socket, CHROME_CONTROLLER_ALLOW_RELAY: undefined, HTTP_PORT: undefined }, async () => {
        await assert.rejects(
          () => sendCommand('queryTabs'),
          (err: IpcError) => {
            assert.strictEqual(err.kind, 'unavailable');
            assert.match(err.message, /^NATIVE_IPC_UNAVAILABLE: /);
            assert.ok(err.message.includes(socket));
            assert.ok(err.message.includes(code), `the underlying ${code} must be visible`);
            assert.match(err.message, /set CHROME_CONTROLLER_ALLOW_RELAY=1/);
            return true;
          },
        );
      });
    }
  } finally {
    stale.cleanup();
  }
});

test('sendCommand falls back to the relay when the socket is missing or stale', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const stale = await makeStaleSocket();
  const missing = path.join(os.tmpdir(), `mcp-missing-${process.pid}-${Date.now()}.sock`);
  const relay = await startFakeRelay();
  try {
    for (const socket of [missing, stale.socket]) {
      await withEnv(relayAllowedEnv(socket, relay.instance), async () => {
        const result = await sendCommand('queryTabs', { queryInfo: { active: true } });
        assert.deepStrictEqual(result, { via: 'relay' });
      });
    }
    assert.strictEqual(relay.hits.length, 2);
    assert.deepStrictEqual(relay.hits[0], { queryInfo: { active: true }, action: 'queryTabs' });
  } finally {
    stale.cleanup();
    await relay.close();
  }
});

test('sendCommand never relays a native-only action, even when IPC is unavailable and the relay is allowed', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const missing = path.join(os.tmpdir(), `mcp-missing-${process.pid}-${Date.now()}.sock`);
  const relay = await startFakeRelay();
  try {
    await withEnv(relayAllowedEnv(missing, relay.instance), async () => {
      for (const [action, params] of [
        ['extractSecretGuarded', {}],
        ['injectSecretGuarded', { value: 'not-a-real-secret' }],
        ['evaluateOnPage', { sensitive: true }],
      ] as const) {
        await assert.rejects(
          () => sendCommand(action, params),
          (err: IpcError) => {
            assert.strictEqual(err.kind, 'unavailable', action);
            assert.match(err.message, /^NATIVE_IPC_UNAVAILABLE: /);
            // Suggesting ALLOW_RELAY here would be wrong: it cannot help.
            assert.match(err.message, /never sent over the relay/);
            assert.doesNotMatch(err.message, /CHROME_CONTROLLER_ALLOW_RELAY/);
            return true;
          },
        );
      }
    });
    assert.strictEqual(relay.hits.length, 0);
  } finally {
    await relay.close();
  }
});

// HTTP_PORT routes non-sensitive actions straight to the relay without trying
// IPC. A live fake host proves IPC was not attempted, rather than attempted
// and failed over.
test('sendCommand goes straight to the HTTP relay when HTTP_PORT is set', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const host = await startFakeHost((client) => {
    client.write(JSON.stringify({ success: true, result: { via: 'ipc' } }) + '\n');
  });
  const relay = await startFakeRelay();
  try {
    await withEnv({
      CHROME_CONTROLLER_SOCKET: host.socket,
      CHROME_CONTROLLER_INSTANCE: relay.instance,
      HTTP_PORT: String(relay.port),
      API_KEY: undefined,
    }, async () => {
      assert.deepStrictEqual(await sendCommand('queryTabs'), { via: 'relay' });
    });
    assert.strictEqual(host.requests.length, 0, 'IPC must not be attempted when HTTP_PORT is set');
    assert.strictEqual(relay.hits.length, 1);
  } finally {
    await host.close();
    await relay.close();
  }
});

test('sendCommand decodes a multi-byte character split across IPC reads', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const text = 'Привіт, café ☕ done';
  const host = await startFakeHost((client) => {
    const bytes = Buffer.from(JSON.stringify({ success: true, result: { text } }) + '\n', 'utf8');
    const cut = bytes.indexOf(Buffer.from('☕', 'utf8')) + 1; // inside the 3-byte sequence
    client.write(bytes.subarray(0, cut));
    setTimeout(() => client.end(bytes.subarray(cut)), 25);
  });
  try {
    await withEnv({ CHROME_CONTROLLER_SOCKET: host.socket, HTTP_PORT: undefined }, async () => {
      assert.deepStrictEqual(await sendCommand('extractContent', { tabId: 1 }), { text });
    });
  } finally {
    await host.close();
  }
});

/** IPC only: relay fallback disabled, so a regression that relays fails instead of reaching a real relay. */
function ipcOnlyEnv(socket: string): Record<string, string | undefined> {
  return { CHROME_CONTROLLER_SOCKET: socket, CHROME_CONTROLLER_ALLOW_RELAY: undefined, HTTP_PORT: undefined };
}

/** Gives a connection the client should not have opened time to reach the server. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

test('sendCommand reads a multi-megabyte answer well within the IPC timeout', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  // Screenshots and video frames are this large. Rescanning the whole buffer
  // for the newline on every read was quadratic: 16 MB took ~5-9 s on macOS,
  // long enough to be reported as a wedged host. The answer is written in
  // paced 8 KB slices so the client sees many small reads on every platform
  // (Linux would otherwise deliver fewer, larger reads and hide the cost).
  const frame = 'A'.repeat(16 * 1024 * 1024);
  const answer = Buffer.from(JSON.stringify({ success: true, result: { data: frame } }) + '\n');
  const host = await startFakeHost((client) => {
    let offset = 0;
    const writeNext = () => {
      if (offset >= answer.length || client.destroyed) return;
      const slice = answer.subarray(offset, offset + 8192);
      offset += slice.length;
      client.write(slice, () => setImmediate(writeNext));
    };
    writeNext();
  });
  try {
    await withEnv(ipcOnlyEnv(host.socket), async () => {
      const started = Date.now();
      // The IPC timeout is well above the budget, so a slow read reports
      // how slow instead of an ambiguous NATIVE_IPC_TIMEOUT.
      const result = await sendCommand('captureScreenshot', { tabId: 1 }, 12_000) as { data: string };
      const elapsed = Date.now() - started;
      assert.strictEqual(result.data.length, frame.length);
      assert.ok(result.data === frame, 'the answer must arrive intact');
      assert.ok(elapsed < 3000, `took ${elapsed}ms`);
    });
  } finally {
    await host.close();
  }
});

test('sendCommand treats a numeric socket path as a path and never dials a TCP port', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  // net.connect('8898') dials TCP 127.0.0.1:8898, the relay's port. A live TCP
  // listener on the numeric "path" proves the client does not reach it.
  let tcpConnections = 0;
  const tcp = net.createServer((client) => { tcpConnections++; client.destroy(); });
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', () => resolve()));
  const port = String((tcp.address() as net.AddressInfo).port);
  try {
    await withEnv(ipcOnlyEnv(port), async () => {
      await assert.rejects(
        () => sendCommand('queryTabs', {}, 2000),
        (err: IpcError) => {
          assert.strictEqual(err.kind, 'unavailable');
          assert.match(err.message, /^NATIVE_IPC_UNAVAILABLE: .*ENOENT/);
          return true;
        },
      );
    });
    await settle();
    assert.strictEqual(tcpConnections, 0);
  } finally {
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  }
});

test('sendCommand rejects an unserializable payload without connecting to the host', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  // Serializing inside the connect callback threw there, outside the promise,
  // instead of failing the one tool call.
  const host = await startFakeHost((client) => {
    client.write(JSON.stringify({ success: true, result: 'should not be reached' }) + '\n');
  });
  try {
    await withEnv(ipcOnlyEnv(host.socket), async () => {
      await assert.rejects(() => sendCommand('evaluateOnPage', { tabId: 1, value: 1n }, 2000), TypeError);
    });
    await settle();
    assert.strictEqual(host.disconnects.length, 0, 'no connection may be opened for a request that cannot be sent');
  } finally {
    await host.close();
  }
});

test('sendCommand rejects an invalid IPC timeout before connecting instead of reporting a host timeout', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const host = await startFakeHost(() => {});
  try {
    await withEnv(ipcOnlyEnv(host.socket), async () => {
      for (const timeoutMs of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
        await assert.rejects(() => sendCommand('queryTabs', {}, timeoutMs), RangeError, String(timeoutMs));
      }
    });
    await settle();
    assert.strictEqual(host.disconnects.length, 0);
  } finally {
    await host.close();
  }
});

test('sendCommand reports an object answer without a boolean success as malformed, not as a rejection', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const relay = await startFakeRelay();
  try {
    for (const answer of [{ result: 1 }, { success: 'false', error: 'x' }, { success: 1, result: 1 }]) {
      const host = await startFakeHost((client) => client.write(JSON.stringify(answer) + '\n'));
      try {
        await withEnv(relayAllowedEnv(host.socket, relay.instance), async () => {
          await assert.rejects(
            () => sendCommand('queryTabs', {}, 2000),
            (err: IpcError) => {
              assert.strictEqual(err.kind, 'protocol', JSON.stringify(answer));
              assert.match(err.message, /^NATIVE_IPC_PROTOCOL_ERROR: .*returned a malformed response without a boolean success/);
              assert.match(err.message, NOT_RETRIED);
              return true;
            },
          );
        });
      } finally {
        await host.close();
      }
    }
    assert.strictEqual(relay.hits.length, 0, 'the host was reached, so the request must not be replayed');
  } finally {
    await relay.close();
  }
});

test('sendCommand resolves the host result as-is, including falsy results', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  // A falsy result (0, '', null, false) is a real answer and must not be
  // mistaken for "no IPC answer" and sent to the relay.
  const relay = await startFakeRelay();
  try {
    for (const result of [0, '', null, false, [], { nested: { ok: true } }]) {
      const host = await startFakeHost((client) => client.write(JSON.stringify({ success: true, result }) + '\n'));
      try {
        await withEnv(relayAllowedEnv(host.socket, relay.instance), async () => {
          assert.deepStrictEqual(await sendCommand('evaluateOnPage', { tabId: 1 }), result);
        });
        assert.deepStrictEqual(host.requests, [{ action: 'evaluateOnPage', tabId: 1 }]);
      } finally {
        await host.close();
      }
    }
    assert.strictEqual(relay.hits.length, 0);
  } finally {
    await relay.close();
  }
});

test('sendCommand reports a host rejection as a HostRejectedError', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const host = await startFakeHost((client) => client.write(JSON.stringify({ success: false, error: 'nope' }) + '\n'));
  try {
    await withEnv(ipcOnlyEnv(host.socket), async () => {
      await assert.rejects(() => sendCommand('queryTabs', {}, 2000), (err: Error) => {
        assert.ok(err instanceof HostRejectedError);
        assert.strictEqual(err.name, 'HostRejectedError');
        assert.strictEqual(err.message, 'nope');
        return true;
      });
    });
  } finally {
    await host.close();
  }
});

test('sendCommand names the MCP relay settings, not the Pi ones, when IPC is unavailable', IPC_TEST, async () => {
  const missing = path.join(os.tmpdir(), `mcp-missing-${process.pid}-${Date.now()}.sock`);
  await withEnv(ipcOnlyEnv(missing), async () => {
    await assert.rejects(() => sendCommand('queryTabs'), (err: IpcError) => {
      assert.ok(err.message.includes('(set CHROME_CONTROLLER_ALLOW_RELAY=1 or HTTP_PORT)'), err.message);
      assert.doesNotMatch(err.message, /CHROME_CONTROLLER_URL/);
      return true;
    });
  });
});

const NATIVE_ONLY_CASES = [
  ['extractSecretGuarded', {}],
  ['injectSecretGuarded', { value: 'not-a-real-secret' }],
  ['evaluateOnPage', { sensitive: true }],
] as const;

test('sendCommand keeps native-only actions on IPC even when HTTP_PORT routes everything else to the relay', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const host = await startFakeHost((client) => client.write(JSON.stringify({ success: true, result: { via: 'ipc' } }) + '\n'));
  const relay = await startFakeRelay();
  const missing = path.join(os.tmpdir(), `mcp-missing-${process.pid}-${Date.now()}.sock`);
  const httpEnv = (socket: string) => ({
    CHROME_CONTROLLER_SOCKET: socket,
    CHROME_CONTROLLER_INSTANCE: relay.instance,
    HTTP_PORT: String(relay.port),
    API_KEY: undefined,
    CHROME_CONTROLLER_ALLOW_RELAY: undefined,
  });
  try {
    await withEnv(httpEnv(host.socket), async () => {
      for (const [action, params] of NATIVE_ONLY_CASES) {
        assert.deepStrictEqual(await sendCommand(action, params), { via: 'ipc' }, action);
      }
    });
    await withEnv(httpEnv(missing), async () => {
      for (const [action, params] of NATIVE_ONLY_CASES) {
        await assert.rejects(() => sendCommand(action, params), (err: IpcError) => {
          assert.strictEqual(err.kind, 'unavailable', action);
          assert.match(err.message, /never sent over the relay/);
          return true;
        });
      }
    });
    assert.deepStrictEqual(host.requests.map((r) => r.action), NATIVE_ONLY_CASES.map(([action]) => action));
    assert.strictEqual(relay.hits.length, 0, 'sensitive payloads must never reach the relay');
  } finally {
    await host.close();
    await relay.close();
  }
});

test('sendCommand keeps the timeout and protocol labels for a native-only action the host received', IPC_TEST, async () => {
  if (process.platform === 'win32') return;
  const relay = await startFakeRelay();
  try {
    for (const [behaviour, kind, prefix] of [
      [() => {}, 'timeout', /^NATIVE_IPC_TIMEOUT: /],
      [(client: net.Socket) => client.end(), 'protocol', /^NATIVE_IPC_PROTOCOL_ERROR: /],
    ] as const) {
      const host = await startFakeHost(behaviour as (client: net.Socket) => void);
      try {
        await withEnv(relayAllowedEnv(host.socket, relay.instance), async () => {
          await assert.rejects(() => sendCommand('injectSecretGuarded', { value: 'not-a-real-secret' }, 500), (err: IpcError) => {
            assert.strictEqual(err.kind, kind);
            assert.match(err.message, prefix);
            assert.match(err.message, NOT_RETRIED, 'the secret may already have been typed');
            assert.doesNotMatch(err.message, /NATIVE_IPC_UNAVAILABLE|never sent over the relay/);
            return true;
          });
        });
        assert.strictEqual(host.requests.length, 1);
      } finally {
        await host.close();
      }
    }
    assert.strictEqual(relay.hits.length, 0);
  } finally {
    await relay.close();
  }
});

test('buildHealthReport never consults Chrome when the host is not alive', async () => {
  for (const state of ['wedged', 'stale-socket', 'down'] as const) {
    let queried = false;
    const report = await buildHealthReport(
      async () => ({ state, socketPath: '/s', pid: 1, detail: `host is ${state}` }),
      async () => { queried = true; return []; },
    );
    assert.strictEqual(queried, false, `${state} must not hang on a Chrome round-trip`);
    assert.strictEqual(report.success, false);
    assert.strictEqual(report.hostState, state);
    assert.strictEqual(report.extensionConnected, false);
    assert.strictEqual(report.remediation, HOST_STATE_REMEDIATION[state]);
    assert.strictEqual(report.detail, `host is ${state}`);
  }
});

test('buildHealthReport separates a silent extension from a healthy host', async () => {
  const report = await buildHealthReport(
    async () => ({ state: 'alive', socketPath: '/s', pid: 1, detail: 'ok' }),
    async () => { throw new Error('Native Messaging request timed out after 8000ms'); },
  );
  assert.strictEqual(report.success, false);
  assert.strictEqual(report.hostState, 'alive');
  assert.strictEqual(report.extensionConnected, false);
  assert.match(String(report.detail), /host is healthy but Chrome did not answer/);
  assert.match(String(report.detail), /timed out after 8000ms/);
  assert.strictEqual(report.remediation, HOST_STATE_REMEDIATION.extensionSilent);
});

test('buildHealthReport reports success when both sides answer', async () => {
  const report = await buildHealthReport(
    async () => ({ state: 'alive', socketPath: '/s', pid: 1, detail: 'ok' }),
    async () => [{ id: 1, url: 'https://example.test/' }],
  );
  assert.strictEqual(report.success, true);
  assert.strictEqual(report.hostState, 'alive');
  assert.strictEqual(report.extensionConnected, true);
  assert.deepStrictEqual(report.result, [{ id: 1, url: 'https://example.test/' }]);
});

test('buildHealthReport degrades to structured output when the probe itself throws', async () => {
  let queried = false;
  const report = await buildHealthReport(
    async () => { throw new Error('socket path is a symlink'); },
    async () => { queried = true; return []; },
  );
  assert.strictEqual(queried, false);
  assert.strictEqual(report.success, false);
  assert.strictEqual(report.hostState, 'unknown');
  assert.match(String(report.detail), /Could not probe the native host: socket path is a symlink/);
  assert.strictEqual(typeof report.remediation, 'string');
});

test('every non-alive host state has remediation text', () => {
  for (const state of ['wedged', 'stale-socket', 'down'] as const) {
    assert.strictEqual(typeof HOST_STATE_REMEDIATION[state], 'string');
    assert.ok(HOST_STATE_REMEDIATION[state].length > 0);
  }
  assert.ok(HOST_STATE_REMEDIATION.extensionSilent.includes('chrome://extensions'));
});

test('a health check against a silent Chrome reports the host\'s answer, not a client timeout', async (t) => {
  if (process.platform === 'win32') return;
  assert.ok(HEALTH_PROBE_TIMEOUT_MS < HEALTH_CHROME_WAIT_MS);
  const chrome = await startScriptedChrome('mcp-health-wait-');
  t.after(() => chrome.close());
  t.after(setEnv({ CHROME_CONTROLLER_SOCKET: chrome.socketPath, HTTP_PORT: undefined, CHROME_CONTROLLER_ALLOW_RELAY: undefined }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Equal waits race: whichever fires first decides whether the operator sees
  // the ambiguous IPC timeout or the definitive "Chrome did not answer".
  const report = buildHealthReport(
    async () => ({ state: 'alive', detail: 'scripted' } as never),
    () => sendCommand('queryTabs', { timeoutMs: HEALTH_CHROME_WAIT_MS }),
  );
  await chrome.nextRequest();
  t.mock.timers.tick(HEALTH_CHROME_WAIT_MS);
  const result = await report;
  assert.equal(result.hostState, 'alive');
  assert.equal(result.extensionConnected, false);
  assert.match(String(result.detail), /Native Messaging request timed out after 8000ms/);
});

// ── IPC client wait vs. the host's Chrome wait ──────────────────────────────
//
// These drive a real NativeMessagingHost whose Chrome is scripted, with both
// the host's timer and the IPC client's timer on the mocked clock, so each test
// decides which deadline is reached first.

test('a healthy host delivers its own Chrome timeout before the IPC client gives up', async (t) => {
  if (process.platform === 'win32') return;
  const chrome = await startScriptedChrome('mcp-wait-order-');
  const restoreEnv = setEnv({ CHROME_CONTROLLER_SOCKET: chrome.socketPath, HTTP_PORT: undefined, CHROME_CONTROLLER_ALLOW_RELAY: undefined });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const outcome = sendCommand('queryTabs').then(() => 'resolved', (error: Error) => error.message);
    await chrome.nextRequest(); // Chrome has the request and never answers.
    t.mock.timers.tick(15000); // the host's default Chrome wait
    const message = await outcome;
    // The host's answer is definitive: the host is fine and Chrome did not answer.
    // A client-side timeout here would instead blame "wedged host or slow Chrome".
    assert.match(message, /Native Messaging request timed out after 15000ms/);
    assert.doesNotMatch(message, /NATIVE_IPC_TIMEOUT/);
  } finally {
    restoreEnv();
    chrome.close();
  }
});

// Wall-clock durations of real actions, measured against a live Chrome through
// the native host (docs/leanings/2026-09-23-ipc-client-gave-up-before-the-host-it-was-waiting-on.md).
const MEASURED_CHROME_WORK: { name: string; action: string; params: Record<string, unknown>; chromeMs: number }[] = [
  { name: 'captureVideo at its defaults (5 fps, 3 s, jpeg)', action: 'captureVideo', params: { tabId: 1 }, chromeMs: 8150 },
  { name: 'captureVideo as png', action: 'captureVideo', params: { tabId: 1, fps: 5, duration: 3, format: 'png' }, chromeMs: 11016 },
  { name: 'captureVideo at 10 fps for 3 s', action: 'captureVideo', params: { tabId: 1, fps: 10, duration: 3 }, chromeMs: 11406 },
  { name: 'captureVideo at 30 fps for 2 s', action: 'captureVideo', params: { tabId: 1, fps: 30, duration: 2 }, chromeMs: 21968 },
  { name: 'getConsoleLogs with its 2 s collection window', action: 'getConsoleLogs', params: { tabId: 1, timeoutMs: 2000 }, chromeMs: 2007 },
  {
    name: 'animated typing of 52 characters at 50 ms',
    action: 'sendCommand',
    params: {
      tabId: 1,
      method: 'Input.insertText',
      commandParams: { text: 'The quick brown fox, jumps over the lazy dog. Again!', animateTyping: true, typingDelayMs: 50, sound: false },
    },
    chromeMs: 10423,
  },
  {
    // chrome_type_text's own shape: the same typing inside a batch, after the
    // ~345 ms ensureDebugger measured on a live Chrome.
    name: 'chrome_type_text\'s batch typing 52 characters at 50 ms',
    action: 'batch',
    params: {
      mode: 'sequential',
      actions: [
        { action: 'ensureDebugger', tabId: 1 },
        {
          action: 'sendCommand',
          tabId: 1,
          method: 'Input.insertText',
          commandParams: { text: 'The quick brown fox, jumps over the lazy dog. Again!', animateTyping: true, typingDelayMs: 50, sound: false },
        },
      ],
    },
    chromeMs: 10423 + 345,
  },
];

for (const { name, action, params, chromeMs } of MEASURED_CHROME_WORK) {
  test(`${name}, answered after the measured ${chromeMs}ms, reaches the caller`, async (t) => {
    if (process.platform === 'win32') return;
    const chrome = await startScriptedChrome('mcp-measured-work-');
    const restoreEnv = setEnv({ CHROME_CONTROLLER_SOCKET: chrome.socketPath, HTTP_PORT: undefined, CHROME_CONTROLLER_ALLOW_RELAY: undefined });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const outcome = sendCommand(action, params);
      outcome.catch(() => {}); // still asserted below; avoids an unhandled rejection if setup fails first
      const request = await chrome.nextRequest();
      t.mock.timers.tick(chromeMs);
      chrome.answer(request.id, { finished: action });
      assert.deepStrictEqual(await outcome, { finished: action });
    } finally {
      restoreEnv();
      chrome.close();
    }
  });
}

test('a guarded extraction whose Chrome goes silent gets the host\'s fail-closed answer, not a client timeout', async (t) => {
  if (process.platform === 'win32') return;
  const chrome = await startScriptedChrome('mcp-guarded-wait-');
  const restoreEnv = setEnv({ CHROME_CONTROLLER_SOCKET: chrome.socketPath, HTTP_PORT: undefined, CHROME_CONTROLLER_ALLOW_RELAY: undefined });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const outcome = sendCommand('extractSecretGuarded', { tabId: 7, selector: '#token' })
      .then(() => 'resolved', (error: Error) => error.message);
    // The page action gets no answer within the host's ordinary wait...
    const evaluate = await chrome.nextRequest();
    assert.equal(evaluate.action, 'evaluateOnPage');
    t.mock.timers.tick(15000);
    // ...so the host tries to close the tab, which gets no answer either.
    const close = await chrome.nextRequest();
    assert.equal(close.action, 'removeTab');
    t.mock.timers.tick(15000);
    // Only the host knows the tab may still hold the secret; a client timeout
    // would have dropped that instruction on the floor.
    assert.match(await outcome, /Guarded extraction failed and the source tab could not be closed/);
  } finally {
    restoreEnv();
    chrome.close();
  }
});

test('over the relay, an action with work of its own carries its wait; an ordinary one is sent unchanged', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  const restoreEnv = setEnv({ HTTP_PORT: String(port), API_KEY: TEST_API_KEY });
  try {
    await sendCommand('captureVideo', { tabId: 1, fps: 30, duration: 2 });
    await sendCommand('getConsoleLogs', { tabId: 1, timeoutMs: 2000 });
    await sendCommand('queryTabs', { queryInfo: {} });
    // The relay's own default wait (10s) knows nothing of the action.
    // 15 s + 60 frames x (33 ms interval + 1000 ms allowance): past the 21968 ms measured.
    assert.equal(bodies[0].requestTimeoutMs, 76980);
    assert.equal(bodies[1].timeoutMs, 2000, 'the collection window still reaches the extension');
    assert.equal(bodies[1].requestTimeoutMs, 17000);
    assert.deepStrictEqual(bodies[2], { queryInfo: {}, action: 'queryTabs' });
  } finally {
    restoreEnv();
    server.close();
  }
});

test('a 30 MB answer is read within the delivery margin, so a client timeout still means the host missed its deadline', async () => {
  if (process.platform === 'win32') return;
  // Real timers: the host answers at once, so the client's whole budget is the
  // 1 ms wait plus the delivery margin, which must cover reading the answer.
  const bytes = 30 * 1024 * 1024;
  const host = await startLargeAnswerHost('mcp-large-answer-', bytes);
  const restoreEnv = setEnv({ CHROME_CONTROLLER_SOCKET: host.socketPath, HTTP_PORT: undefined, CHROME_CONTROLLER_ALLOW_RELAY: undefined });
  try {
    const result = await sendCommand('queryTabs', { requestTimeoutMs: 1 }) as { data: string };
    assert.equal(result.data.length, bytes);
  } finally {
    restoreEnv();
    host.close();
  }
});

test('over the real relay, a long action inside a batch gets its own wait', async () => {
  // The relay splits a batch and waits for each item separately, so the wait
  // stamped on the batch as a whole never reaches the items.
  const relay = createChromeControllerServer({ httpPort: 0, wsPort: 0, apiKey: TEST_API_KEY, writeDiscoveryFile: false });
  const { httpPort, wsPort } = await relay.ready;
  // A fake extension that, like the real one, answers getConsoleLogs only after
  // its collection window, plus the ~7 ms of setup measured on a live Chrome.
  const extension = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}?key=${TEST_API_KEY}`);
    ws.on('error', reject);
    ws.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString());
      if (message.id === undefined) return;
      const delayMs = message.action === 'getConsoleLogs' ? Number(message.timeoutMs) + 100 : 0;
      setTimeout(() => ws.send(JSON.stringify({ id: message.id, result: { handled: message.action } })), delayMs);
    });
    ws.on('open', () => setTimeout(() => resolve(ws), 50));
  });
  const restoreEnv = setEnv({ HTTP_PORT: String(httpPort), API_KEY: TEST_API_KEY });
  try {
    const bare = await sendCommand('getConsoleLogs', { tabId: 1, timeoutMs: 300 });
    assert.deepStrictEqual(bare, { handled: 'getConsoleLogs' });
    // The relay answers 200 only when every item succeeded, and 207 (which
    // sendCommand rejects as `HTTP 207`) when any item timed out.
    await sendCommand('batch', {
      mode: 'sequential',
      actions: [{ action: 'getConsoleLogs', tabId: 1, timeoutMs: 300 }, { action: 'queryTabs' }],
    });
  } finally {
    restoreEnv();
    extension.close();
    relay.close();
  }
});

test('a guarded injection whose Chrome goes silent gets the host\'s fail-closed answer, not a client timeout', async (t) => {
  if (process.platform === 'win32') return;
  const chrome = await startScriptedChrome('mcp-guarded-inject-');
  t.after(() => chrome.close());
  t.after(setEnv({ CHROME_CONTROLLER_SOCKET: chrome.socketPath, HTTP_PORT: undefined, CHROME_CONTROLLER_ALLOW_RELAY: undefined }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const outcome = sendCommand('injectSecretGuarded', { tabId: 7, selector: '#password', value: 'synthetic-value-9' })
    .then(() => 'resolved', (error: Error) => error.message);
  assert.equal((await chrome.nextRequest()).action, 'evaluateOnPage');
  t.mock.timers.tick(15000);
  assert.equal((await chrome.nextRequest()).action, 'removeTab');
  t.mock.timers.tick(15000);
  assert.match(await outcome, /Guarded injection failed and the target tab could not be closed/);
});

test('a request that cannot finish within the cap is refused before it reaches the host or the relay', async () => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fail-fast-'));
  const socketPath = path.join(dir, 'run.sock');
  let connections = 0;
  const host = net.createServer((socket) => {
    connections++;
    socket.end('{"success":true,"result":"typed"}\n');
  });
  await new Promise<void>((resolve) => host.listen(socketPath, resolve));
  const restoreEnv = setEnv({ CHROME_CONTROLLER_SOCKET: socketPath, HTTP_PORT: undefined, CHROME_CONTROLLER_ALLOW_RELAY: '1' });
  try {
    // 5000 animated keystrokes at the default delay need more than 120 s of Chrome time.
    await assert.rejects(
      () => sendCommand('batch', buildTypeTextBatchForTest('x'.repeat(5000))),
      /^Error: batch needs at least \d+ms of Chrome time, beyond the 120000ms limit/,
    );
    // Never sent: a relay attempt would instead fail on the missing relay config.
    assert.equal(connections, 0);
  } finally {
    restoreEnv();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function buildTypeTextBatchForTest(text: string): Record<string, unknown> {
  return {
    mode: 'sequential',
    actions: [
      { action: 'ensureDebugger', tabId: 1 },
      { action: 'sendCommand', tabId: 1, method: 'Input.insertText', commandParams: { text, animateTyping: true, typingDelayMs: 50 } },
    ],
  };
}
