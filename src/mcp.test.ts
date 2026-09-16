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
import { readDiscovery, getConfig, sendCommand } from './mcp.js';

// ── readDiscovery tests ──────────────────────────────────────────────────────

test('readDiscovery returns null for non-existent file', () => {
  const result = readDiscovery('nonexistent-instance');
  assert.strictEqual(result, null);
});

test('readDiscovery returns parsed data for valid file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  const instancePath = path.join(tmpDir, 'test-discovery.json');
  const discoveryData = { httpPort: 9999, apiKey: 'TEST-KEY-123' };
  fs.writeFileSync(instancePath, JSON.stringify(discoveryData));

  // Monkey-patch DISCOVERY_DIR indirectly: we can't, so write to actual ~/.chrome-controller
  const testInstance = 'mcp-test-' + Date.now();
  const discoveryDir = path.join(os.homedir(), '.chrome-controller');
  fs.writeFileSync(
    path.join(discoveryDir, `${testInstance}.json`),
    JSON.stringify(discoveryData)
  );

  try {
    const result = readDiscovery(testInstance);
    assert.deepStrictEqual(result, discoveryData);
  } finally {
    fs.rmSync(path.join(discoveryDir, `${testInstance}.json`), { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readDiscovery returns null for malformed JSON', () => {
  const testInstance = 'mcp-test-malformed-' + Date.now();
  const discoveryDir = path.join(os.homedir(), '.chrome-controller');
  fs.writeFileSync(path.join(discoveryDir, `${testInstance}.json`), 'not-json{{{');

  try {
    const result = readDiscovery(testInstance);
    assert.strictEqual(result, null);
  } finally {
    fs.rmSync(path.join(discoveryDir, `${testInstance}.json`), { force: true });
  }
});

// ── getConfig tests ─────────────────────────────────────────────────────────

test('getConfig returns defaults when no env or discovery', () => {
  const origHttpPort = process.env.HTTP_PORT;
  const origApiKey = process.env.API_KEY;
  const origInstance = process.env.CHROME_CONTROLLER_INSTANCE;

  delete process.env.HTTP_PORT;
  delete process.env.API_KEY;
  process.env.CHROME_CONTROLLER_INSTANCE = 'mcp-test-no-discovery-' + Date.now();

  try {
    const config = getConfig();
    assert.strictEqual(config.httpPort, 8898);
    assert.strictEqual(config.apiKey, 'B3C65095-74E1-4F48-9EBB-64F5DD6AB078');
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
  process.env.API_KEY = 'MY-SECRET-KEY';

  try {
    const config = getConfig();
    assert.strictEqual(config.httpPort, 12345);
    assert.strictEqual(config.apiKey, 'MY-SECRET-KEY');
  } finally {
    if (origHttpPort !== undefined) process.env.HTTP_PORT = origHttpPort;
    else delete process.env.HTTP_PORT;
    if (origApiKey !== undefined) process.env.API_KEY = origApiKey;
    else delete process.env.API_KEY;
  }
});

test('getConfig uses only HTTP_PORT when API_KEY is absent', () => {
  const origHttpPort = process.env.HTTP_PORT;
  const origApiKey = process.env.API_KEY;
  const origInstance = process.env.CHROME_CONTROLLER_INSTANCE;

  process.env.HTTP_PORT = '5555';
  delete process.env.API_KEY;
  process.env.CHROME_CONTROLLER_INSTANCE = 'mcp-test-partial-' + Date.now();

  try {
    const config = getConfig();
    assert.strictEqual(config.httpPort, 5555);
    // Falls back to discovery or default for apiKey
    assert.ok(typeof config.apiKey === 'string' && config.apiKey.length > 0);
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
  process.env.CHROME_CONTROLLER_INSTANCE = 'mcp-test-default-' + Date.now();

  const discoveryDir = path.join(os.homedir(), '.chrome-controller');
  fs.writeFileSync(
    path.join(discoveryDir, `${process.env.CHROME_CONTROLLER_INSTANCE}.json`),
    JSON.stringify({ httpPort: 7777, apiKey: 'DISCOVERY-KEY' })
  );

  try {
    const config = getConfig();
    assert.strictEqual(config.httpPort, 7777);
    assert.strictEqual(config.apiKey, 'DISCOVERY-KEY');
  } finally {
    fs.rmSync(path.join(discoveryDir, `${process.env.CHROME_CONTROLLER_INSTANCE}.json`), { force: true });
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

  delete process.env.CHROME_CONTROLLER_INSTANCE;

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
  process.env.API_KEY = 'test-key';

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
  }
});

test('sendCommand rejects when server returns error response', async () => {
  const origApiKey = process.env.API_KEY;
  const origHttpPort = process.env.HTTP_PORT;
  const origInstance = process.env.CHROME_CONTROLLER_INSTANCE;

  delete process.env.CHROME_CONTROLLER_INSTANCE;

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
  process.env.API_KEY = 'test-key';

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

test('sendCommand falls back to HTTP relay when CHROME_CONTROLLER_ALLOW_RELAY=1 and IPC is down', async () => {
  const origHttpPort = process.env.HTTP_PORT;
  const origAllowRelay = process.env.CHROME_CONTROLLER_ALLOW_RELAY;
  const origSocket = process.env.CHROME_CONTROLLER_SOCKET;
  const origApiKey = process.env.API_KEY;

  const server = http.createServer((req, res) => {
    let _body = '';
    req.on('data', (chunk: Buffer) => { _body += chunk.toString(); });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { fallbackSuccess: true } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;

  process.env.HTTP_PORT = String(port);
  process.env.API_KEY = 'test-key';
  process.env.CHROME_CONTROLLER_ALLOW_RELAY = '1';
  process.env.CHROME_CONTROLLER_SOCKET = '/tmp/nonexistent-relay-socket-' + Date.now() + '.sock';

  try {
    const result = await sendCommand('queryTabs');
    assert.deepStrictEqual(result, { fallbackSuccess: true });
  } finally {
    server.close();
    if (origHttpPort !== undefined) process.env.HTTP_PORT = origHttpPort;
    else delete process.env.HTTP_PORT;
    if (origAllowRelay !== undefined) process.env.CHROME_CONTROLLER_ALLOW_RELAY = origAllowRelay;
    else delete process.env.CHROME_CONTROLLER_ALLOW_RELAY;
    if (origSocket !== undefined) process.env.CHROME_CONTROLLER_SOCKET = origSocket;
    else delete process.env.CHROME_CONTROLLER_SOCKET;
    if (origApiKey !== undefined) process.env.API_KEY = origApiKey;
    else delete process.env.API_KEY;
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


