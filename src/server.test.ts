/**
 * Integration tests for the Chrome Controller WebSocket/HTTP server.
 *
 * Spins up an isolated server instance per test suite using createChromeControllerServer(),
 * then uses a mock extension (WebSocket client) to verify the full relay path.
 */

import * as assert from 'node:assert/strict';
import * as test from 'node:test';
import { WebSocket } from 'ws';
import { createChromeControllerServer, writeDiscovery, readDiscovery, removeDiscovery, ServerConfig, ChromeControllerServer } from './server';
import { buildMouseBatch, buildTypeTextBatch } from './mcp.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_API_KEY = 'test-key-0123456789abcdef01234567';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function createServer(config?: Partial<ServerConfig>): Promise<ChromeControllerServer> {
  const srv = createChromeControllerServer({
    httpPort: 0,
    wsPort: 0,
    apiKey: TEST_API_KEY,
    writeDiscoveryFile: false,
    ...config
  });
  await srv.ready;
  return srv;
}

function post(server: { httpPort: number }, body: unknown, apiKey: string = TEST_API_KEY, extraHeaders: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
    if (apiKey) headers['x-api-key'] = apiKey;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.httpPort,
        path: '/',
        method: 'POST',
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          req.destroy();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch {
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
          }
        });
      }
    );
    req.on('error', (err) => {
      req.destroy();
      reject(err);
    });
    req.write(data);
    req.end();
  });
}

function get(server: { httpPort: number }, urlPath: string = '/'): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: server.httpPort, path: urlPath, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          req.destroy();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch {
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
          }
        });
      }
    );
    req.on('error', (err) => {
      req.destroy();
      reject(err);
    });
  });
}

// Mock extension that responds to known actions like real background.js
function connectMockExtension(server: { wsPort: number }): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.wsPort}?key=${TEST_API_KEY}`);
    ws.on('error', reject);
    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());
        const id = msg.id;
        if (msg.action === 'queryTabs') {
          ws.send(JSON.stringify({ id, result: { tabs: [{ id: 1, title: 'Mock Tab' }] } }));
        } else if (msg.action === 'navigate') {
          ws.send(JSON.stringify({ id, result: { success: true, url: msg.url || '' } }));
        } else if (msg.action === 'click') {
          if (msg.selector === '#fail') {
            ws.send(JSON.stringify({ id, error: 'Element not found' }));
          } else {
            ws.send(JSON.stringify({ id, result: { success: true } }));
          }
        } else if (msg.action === 'type') {
          ws.send(JSON.stringify({ id, result: { success: true } }));
        } else {
          ws.send(JSON.stringify({ id, error: `Action failed in extension: ${msg.action}` }));
        }
      } catch {
        // ignore malformed messages
      }
    });
    ws.on('open', () => resolve(ws));
  });
}

function connectExtension(server: { wsPort: number }): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.wsPort}?key=${TEST_API_KEY}`);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('Server - Basic', () => {
  let server: ChromeControllerServer;
  let ext: WebSocket;

  test.it('starts and responds to health check', async () => {
    server = await createServer();
    const res = await get(server, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  test.it('rejects requests without API key', async () => {
    const res = await post(server, { action: 'queryTabs', queryInfo: {} }, '');
    assert.equal(res.status, 401);
  });

  test.it('rejects requests with wrong API key', async () => {
    const res = await post(server, { action: 'queryTabs', queryInfo: {} }, 'wrong');
    assert.equal(res.status, 401);
  });

  test.it('rejects missing action', async () => {
    const res = await post(server, {});
    assert.equal(res.status, 400);
  });

  test.it('rejects unknown action via extension error', async () => {
    ext = await connectMockExtension(server);
    const res = await post(server, { action: 'removeTab', tabId: 999 });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    ext.close();
    await delay(50);
  });

  test.it('relays queryTabs to extension and back', async () => {
    ext = await connectMockExtension(server);
    const res = await post(server, { action: 'queryTabs', queryInfo: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    ext.close();
    await delay(50);
  });

  test.it('closes gracefully', () => {
    server.close();
  });
});

test.describe('Server - Relay hardening', () => {
  test.it('generates a different high-entropy API key for every unconfigured instance', async () => {
    const first = createChromeControllerServer({ httpPort: 0, wsPort: 0, writeDiscoveryFile: false });
    const second = createChromeControllerServer({ httpPort: 0, wsPort: 0, writeDiscoveryFile: false });
    await Promise.all([first.ready, second.ready]);
    assert.ok(Buffer.byteLength(first.apiKey, 'utf8') >= 32);
    assert.ok(Buffer.byteLength(second.apiKey, 'utf8') >= 32);
    assert.notEqual(first.apiKey, second.apiKey);
    first.close();
    second.close();
  });

  test.it('rejects weak explicit API keys', () => {
    assert.throws(
      () => createChromeControllerServer({ httpPort: 0, wsPort: 0, apiKey: 'short', writeDiscoveryFile: false }),
      /at least 32 bytes/,
    );
  });

  test.it('rejects invalid resource limits and port configuration before opening listeners', () => {
    for (const config of [
      { maxBodyBytes: 0 },
      { maxBodyBytes: Number.NaN },
      { defaultTimeoutMs: 0 },
      { defaultTimeoutMs: 120001 },
      { maxBatchActions: 0 },
      { maxBatchActions: 1001 },
      { httpPort: -1 },
      { wsPort: 65536 },
    ]) {
      assert.throws(
        () => createChromeControllerServer({ ...config, apiKey: TEST_API_KEY, writeDiscoveryFile: false }),
        /must be an integer/,
      );
    }
  });

  test.it('rejects ready and closes listeners when discovery publication fails', async () => {
    const instance = `discovery-failure-${Date.now()}`;
    const blocker = path.join(os.homedir(), '.chrome-controller', `${instance}.json`);
    fs.mkdirSync(path.dirname(blocker), { recursive: true, mode: 0o700 });
    fs.mkdirSync(blocker);
    const server = createChromeControllerServer({
      instance,
      httpPort: 0,
      wsPort: 0,
      apiKey: TEST_API_KEY,
    });
    try {
      await assert.rejects(server.ready, /discovery publication failed/);
      await delay(25);
      assert.equal(server.server.listening, false);
      assert.equal(server.wss.address(), null);
    } finally {
      server.close();
      fs.rmSync(blocker, { recursive: true, force: true });
    }
  });

  test.it('failed same-instance startup cannot remove the active server discovery record', async () => {
    const instance = `discovery-owner-${Date.now()}`;
    const first = createChromeControllerServer({
      instance,
      httpPort: 0,
      wsPort: 0,
      apiKey: TEST_API_KEY,
    });
    await first.ready;
    const expected = readDiscovery(instance);
    assert.ok(expected);

    const second = createChromeControllerServer({
      instance,
      httpPort: 0,
      wsPort: first.wsPort,
      apiKey: 'second-key-0123456789abcdef0123456',
    });
    try {
      await assert.rejects(second.ready, /already in use/);
      second.close();
      assert.deepEqual(readDiscovery(instance), expected);
      assert.equal(first.server.listening, true);
    } finally {
      second.close();
      first.close();
    }
    assert.equal(readDiscovery(instance), null);
  });

  test.it('rejects HTTP requests with a non-loopback Host header', async () => {
    const server = await createServer();
    const res = await post(server, { action: 'queryTabs' }, TEST_API_KEY, { host: 'attacker.example' });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Host or Origin/);
    server.close();
  });

  test.it('rejects HTTP requests with an untrusted Origin and allows an extension Origin', async () => {
    const server = await createServer();
    const rejected = await post(server, { action: 'queryTabs' }, TEST_API_KEY, { origin: 'https://attacker.example' });
    assert.equal(rejected.status, 403);
    const allowed = await post(server, { action: 'queryTabs' }, TEST_API_KEY, {
      origin: `chrome-extension://${'a'.repeat(32)}`,
    });
    assert.equal(allowed.status, 503);
    server.close();
  });

  test.it('rejects WebSocket connections with invalid Host or Origin headers', async () => {
    const server = await createServer();
    for (const headers of [
      { Host: 'attacker.example' },
      { Origin: 'https://attacker.example' },
    ]) {
      const ws = new WebSocket(`ws://127.0.0.1:${server.wsPort}?key=${TEST_API_KEY}`, { headers });
      const { code, reason } = await new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (closeCode, closeReason) => resolve({ code: closeCode, reason: closeReason.toString() }));
      });
      assert.equal(code, 1008);
      assert.match(reason, /Host or Origin/);
    }
    server.close();
  });
});

test.describe('Server - Batch Mode', () => {
  let server: ChromeControllerServer;
  let ext: WebSocket;

  test.it('executes multiple commands in a batch', async () => {
    server = await createServer();
    ext = await connectMockExtension(server);

    const res = await post(server, {
      action: 'batch',
      commands: [
        { action: 'queryTabs', queryInfo: {} },
        { action: 'navigate', url: 'https://example.com' },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.results));
    assert.equal(res.body.results.length, 2);
    for (const item of res.body.results) {
      assert.equal(item.success, true);
    }
  });

  test.it('handles batch with empty commands array', async () => {
    const res = await post(server, { action: 'batch', commands: [] });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    assert.ok(res.body.error.includes('empty'));
  });

  test.it('handles batch with partial failures', async () => {
    const res = await post(server, {
      action: 'batch',
      commands: [
        { action: 'queryTabs', queryInfo: {} },
        { action: 'click', selector: '#fail' },
      ],
    });
    assert.equal(res.status, 207);
    assert.ok(Array.isArray(res.body.results));
    assert.equal(res.body.results.length, 2);
    assert.equal(res.body.results[0].success, true);
    assert.equal(res.body.results[1].success, false);
  });

  test.it('closes gracefully', () => {
    ext.close();
    server.close();
  });
});

test.describe('Server - Connection Rejection', () => {
  let server: ChromeControllerServer;
  let _ext1: WebSocket;

  test.it('closes existing connection on new connection', async () => {
    server = await createServer();
    _ext1 = await connectExtension(server);
    await delay(50);
    const ext2 = await connectExtension(server);
    await delay(200);
    assert.ok(ext2.readyState === WebSocket.OPEN);
    _ext1.close();
    ext2.close();
    await delay(50);
    server.close();
  });

  test.it('accepts new connection after previous disconnects', async () => {
    server = await createServer();
    const w = new WebSocket(`ws://127.0.0.1:${server.wsPort}?key=${TEST_API_KEY}`);
    await new Promise<void>((resolve) => {
      w.on('open', () => w.close());
      w.on('close', () => resolve());
    });
    await delay(100);
    const ext = await connectMockExtension(server);
    const res = await post(server, { action: 'queryTabs', queryInfo: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    ext.close();
    await delay(50);
    server.close();
  });
});

test.describe('Server - HTTP Error Handling', () => {
  let server: ChromeControllerServer;

  test.it('returns 404 for unknown paths', async () => {
    server = await createServer();
    const res = await get(server, '/unknown');
    assert.equal(res.status, 404);
    server.close();
  });

  test.it('returns 503 when no extension is connected', async () => {
    server = await createServer();
    const res = await post(server, { action: 'queryTabs', queryInfo: {} });
    assert.equal(res.status, 503);
    assert.ok(res.body.error);
    server.close();
  });

  test.it('returns 503 after extension disconnects', async () => {
    server = await createServer();
    const ext = await connectExtension(server);
    ext.terminate();
    await delay(500);
    const res = await post(server, { action: 'queryTabs', queryInfo: {} });
    assert.equal(res.status, 503);
    server.close();
  });
});

test.describe('Server - Extension Close Events', () => {
  let server: ChromeControllerServer;
  let ext: WebSocket;

  test.it('extension emits close event when it closes normally', async () => {
    server = await createServer();
    ext = await connectExtension(server);
    const closed = Promise.withResolvers<void>();
    ext.on('close', () => closed.resolve());
    ext.close();
    await Promise.race([closed.promise, delay(1000)]);
    server.close();
  });

  test.it('extension emits close event when it crashes', async () => {
    server = await createServer();
    ext = await connectExtension(server);
    const closed = Promise.withResolvers<void>();
    ext.on('close', () => closed.resolve());
    ext.terminate();
    await Promise.race([closed.promise, delay(1000)]);
    server.close();
  });
});

test.describe('Server - Discovery', () => {
  test.it('writes and reads discovery file', () => {
    const info = { httpPort: 9999, wsPort: 9998, apiKey: TEST_API_KEY, pid: process.pid, startedAt: new Date().toISOString() };
    writeDiscovery('test', info);
    const read = readDiscovery('test');
    assert.equal(read?.httpPort, 9999);
    assert.equal(read?.wsPort, 9998);
    assert.equal(read?.apiKey, TEST_API_KEY);
    removeDiscovery('test');
  });

  test.it('creates directory if it does not exist', () => {
    const info = { httpPort: 1111, wsPort: 1112, apiKey: TEST_API_KEY, pid: process.pid, startedAt: new Date().toISOString() };
    writeDiscovery('disc-nested', info);
    const read = readDiscovery('disc-nested');
    assert.equal(read?.httpPort, 1111);
    removeDiscovery('disc-nested');
  });

  test.it('removes non-existent discovery file without error', () => {
    removeDiscovery('does-not-exist-12345');
  });

  test.it('writes discovery state atomically with private directory and file permissions', () => {
    const instance = `permissions-${Date.now()}`;
    const info = { httpPort: 2221, wsPort: 2222, apiKey: TEST_API_KEY, pid: process.pid, startedAt: new Date().toISOString() };
    writeDiscovery(instance, info);
    const directoryMode = fs.statSync(path.join(os.homedir(), '.chrome-controller')).mode & 0o777;
    const fileMode = fs.statSync(path.join(os.homedir(), '.chrome-controller', `${instance}.json`)).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(fileMode, 0o600);
    removeDiscovery(instance);
  });

  test.it('rejects traversal and malformed instance names', () => {
    const info = { httpPort: 2221, wsPort: 2222, apiKey: TEST_API_KEY, pid: process.pid, startedAt: new Date().toISOString() };
    assert.throws(() => writeDiscovery('../escape', info), /instance/);
    assert.equal(readDiscovery('../escape'), null);
  });

  test.it('refuses discovery files readable by group or other users', () => {
    if (process.platform === 'win32') return;
    const instance = `insecure-mode-${Date.now()}`;
    const info = { httpPort: 2221, wsPort: 2222, apiKey: TEST_API_KEY, pid: process.pid, startedAt: new Date().toISOString() };
    writeDiscovery(instance, info);
    const file = path.join(os.homedir(), '.chrome-controller', `${instance}.json`);
    fs.chmodSync(file, 0o644);
    assert.equal(readDiscovery(instance), null);
    removeDiscovery(instance);
  });

  test.it('removes a discovery record only when the caller owns its exact contents', () => {
    const instance = `conditional-remove-${Date.now()}`;
    const first = { httpPort: 2231, wsPort: 2232, apiKey: TEST_API_KEY, pid: process.pid, startedAt: new Date().toISOString() };
    const replacement = { ...first, apiKey: 'replacement-key-0123456789abcdef0123' };
    writeDiscovery(instance, first);
    writeDiscovery(instance, replacement);
    removeDiscovery(instance, first);
    assert.deepEqual(readDiscovery(instance), replacement);
    removeDiscovery(instance, replacement);
    assert.equal(readDiscovery(instance), null);
  });
});

test.describe('Server - Dynamic Port Assignment', () => {
  let server: ChromeControllerServer;

  test.it('reports actual bound ports in health endpoint', async () => {
    server = await createServer({ httpPort: 0, wsPort: 0 });
    const res = await get(server, '/health');
    assert.equal(res.status, 200);
    assert.ok(res.body.httpPort > 0);
    assert.ok(res.body.wsPort > 0);
    server.close();
  });
});

test.describe('Server - Extension Error Passthrough', () => {
  let server: ChromeControllerServer;
  let ext: WebSocket;

  test.it('passes through errors from extension', async () => {
    server = await createServer();
    ext = await connectMockExtension(server);

    const res = await post(server, { action: 'queryTabs', queryInfo: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const res2 = await post(server, { action: 'click', selector: '#fail' });
    assert.equal(res2.status, 400);
    assert.ok(res2.body.error);

    ext.close();
    await delay(50);
    server.close();
  });
});

test.describe('Server - Batch with actions array', () => {
  let server: ChromeControllerServer;
  let ext: WebSocket;

  test.it('executes batch via commands array', async () => {
    server = await createServer();
    ext = await connectMockExtension(server);

    const res = await post(server, {
      action: 'batch',
      commands: [
        { action: 'queryTabs', queryInfo: {} },
        { action: 'click', selector: '#btn' },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.results));
    assert.equal(res.body.results.length, 2);
    for (const item of res.body.results) {
      assert.equal(item.success, true);
    }
  });

  test.it('rejects batch with disallowed action name', async () => {
    const res = await post(server, {
      action: 'batch',
      commands: [
        { action: 'queryTabs' },
        { action: 'unauthorizedArbitraryCdp' },
      ],
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    assert.ok(res.body.error.includes('specifies disallowed action'));
  });

  test.it('rejects nested batch within batch payload', async () => {
    const res = await post(server, {
      action: 'batch',
      commands: [
        { action: 'queryTabs' },
        { action: 'batch', commands: [] },
      ],
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    assert.ok(res.body.error.includes('cannot be a nested batch'));
  });

  test.it('rejects batch exceeding max actions', async () => {
    const tooMany = Array(51).fill({ action: 'queryTabs' });
    const res = await post(server, { action: 'batch', commands: tooMany });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  test.it('closes gracefully', () => {
    ext.close();
    server.close();
  });
});

test.describe('Server - WS Auth Failure', () => {
  test.it('rejects WebSocket connection with wrong API key', async () => {
    const server = await createServer();
    const ws = new WebSocket(`ws://127.0.0.1:${server.wsPort}?key=wrong`);
    const { code, reason } = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (c, r) => resolve({ code: c, reason: r.toString() }));
    });
    assert.equal(code, 1008);
    assert.equal(reason, 'Invalid API key');
    server.close();
  });

  test.it('rejects WebSocket connection without API key', async () => {
    const server = await createServer();
    const ws = new WebSocket(`ws://127.0.0.1:${server.wsPort}`);
    const { code, reason } = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (c, r) => resolve({ code: c, reason: r.toString() }));
    });
    assert.equal(code, 1008);
    assert.equal(reason, 'Invalid API key');
    server.close();
  });
});

test.describe('Server - Body Size Limits', () => {
  test.it('rejects payload exceeding MAX_BODY_BYTES', async () => {
    const server = await createServer({ maxBodyBytes: 1024 });
    const largePayload = { action: 'queryTabs', padding: 'x'.repeat(2048) };
    const res = await post(server, largePayload);
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    assert.ok(res.body.error.includes('Request body exceeds'));
    server.close();
  });
});

test.describe('Server - Process Command', () => {
  let server: ChromeControllerServer;
  let ext: WebSocket;

  test.it('processes command with missing id gracefully', async () => {
    server = await createServer();
    ext = await connectMockExtension(server);
    const res = await post(server, { action: 'queryTabs' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    ext.close();
    await delay(50);
    server.close();
  });
});

test.describe('Server - Discovery Directory Creation', () => {
  test.it('creates discovery directory if missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-disc2-'));
    const _nested = path.join(tmpDir, 'sub', 'dir');
    const info = { httpPort: 1111, wsPort: 1112, apiKey: TEST_API_KEY, pid: process.pid, startedAt: new Date().toISOString() };
    writeDiscovery('disc-dir-test', info);
    const read = readDiscovery('disc-dir-test');
    assert.equal(read?.httpPort, 1111);
    removeDiscovery('disc-dir-test');
  });

  test.it('readDiscovery returns null for non-existent file', () => {
    const result = readDiscovery('nonexistent-instance-xyz');
    assert.equal(result, null);
  });
});

test.describe('Server - Request Timeout', () => {
  let server: ChromeControllerServer;
  let ext: WebSocket;

  test.it('rejects with timeout when extension does not respond', async () => {
    server = await createServer({ defaultTimeoutMs: 300 });
    ext = await connectExtension(server);
    const res = await post(server, { action: 'queryTabs', queryInfo: {} });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    ext.close();
    await delay(100);
    server.close();
  });

  test.it('rejects invalid per-request timeouts without forwarding the command', async () => {
    server = await createServer();
    ext = await connectMockExtension(server);
    for (const timeoutMs of [0, -1, 1.5, 120001, '10']) {
      const res = await post(server, { action: 'queryTabs', timeoutMs });
      assert.equal(res.status, 400);
      assert.match(String(res.body.error), /Request timeout must be an integer/);
    }
    ext.close();
    server.close();
  });
});

test.describe('Server - Invalid JSON Payload', () => {
  let server: ChromeControllerServer;

  test.it('rejects invalid JSON in request body', async () => {
    server = await createServer();
    const res = await new Promise<any>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.httpPort,
          path: '/',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': TEST_API_KEY },
        },
        (httpRes) => {
          const chunks: Buffer[] = [];
          httpRes.on('data', (chunk) => chunks.push(chunk));
          httpRes.on('end', () => {
            try {
              resolve({ status: httpRes.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
            } catch {
              resolve({ status: httpRes.statusCode, body: Buffer.concat(chunks).toString() });
            }
          });
        }
      );
      req.on('error', () => resolve({ status: 500 }));
      req.write('not-json{');
      req.end();
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    server.close();
  });
});

test.describe('Server - Bearer Token Auth', () => {
  let server: ChromeControllerServer;

  test.it('accepts Bearer token in Authorization header', async () => {
    server = await createServer();
    const res = await post(server, { action: 'queryTabs' }, '', { authorization: `Bearer ${TEST_API_KEY}` });
    assert.equal(res.status, 503);
    server.close();
  });
});

test.after(() => {
  http.globalAgent.destroy();
});

test.describe('Server - CDP input commands inside batches', () => {
  test.it('forwards chrome_type_text and chrome_mouse input, and refuses other raw CDP', async () => {
    const server = await createServer();
    const received: Record<string, unknown>[] = [];
    const ext = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.wsPort}?key=${TEST_API_KEY}`);
      ws.on('error', reject);
      ws.on('message', (data: Buffer | string) => {
        const msg = JSON.parse(data.toString());
        received.push(msg);
        ws.send(JSON.stringify({ id: msg.id, result: { ok: msg.action } }));
      });
      ws.on('open', () => setTimeout(() => resolve(ws), 50));
    });
    try {
      for (const batch of [
        buildTypeTextBatch({ tabId: 7, text: 'hi', instant: true }),
        buildMouseBatch({ tabId: 7, action: 'click', x: 1, y: 2 }),
      ]) {
        const res = await post(server, { action: 'batch', ...batch });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.success, true);
      }
      assert.deepEqual(
        received.filter((msg) => msg.action === 'sendCommand').map((msg) => msg.method),
        ['Input.insertText', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'],
      );

      const forwardedBefore = received.length;
      // The relay splits a batch into top-level messages, which the extension's
      // batch check never sees, so this is the only gate for relay batches.
      const refused: unknown[] = [
        'Runtime.evaluate', 'Page.navigate', undefined,
        'Input.dispatchKeyEvent', 'Input.dispatchDragEvent', 'Input.setIgnoreInputEvents', 'Input.dispatchTouchEvent',
        ['Input.insertText'], 'input.insertText', 'Input.insertText ', 7, { toString: 'Input.insertText' },
      ];
      for (const mode of ['sequential', 'parallel']) {
        for (const method of refused) {
          const res = await post(server, {
            action: 'batch',
            mode,
            actions: [{ action: 'ensureDebugger', tabId: 7 }, { action: 'sendCommand', tabId: 7, method }],
          });
          const label = `${mode} ${JSON.stringify(method)}`;
          assert.equal(res.status, 400, label);
          assert.match(res.body.error, /Batch item 1 sends CDP method .* which batches do not allow/, label);
        }
      }
      assert.equal(received.length, forwardedBefore, 'a refused batch forwards nothing, not even its allowed items');
    } finally {
      ext.close();
      await delay(50);
      server.close();
    }
  });
});
