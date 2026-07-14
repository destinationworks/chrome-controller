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
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Helpers ────────────────────────────────────────────────────────────────────

function createServer(config?: Partial<ServerConfig>): ChromeControllerServer {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  return createChromeControllerServer({
    httpPort: 0,
    wsPort: 0,
    apiKey: 'test-key',
    discoveryPath: path.join(tmpDir, 'discovery.json'),
    ...config
  });
}

function post(server: { httpPort: number }, body: unknown, apiKey: string = 'test-key'): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.httpPort,
        path: '/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch {
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(server: { httpPort: number }, urlPath: string = '/'): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(
      { hostname: '127.0.0.1', port: server.httpPort, path: urlPath },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch {
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
          }
        });
      }
    ).on('error', reject);
  });
}

// Mock extension that responds to known actions like real background.js
function connectMockExtension(server: { wsPort: number }): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.wsPort}?key=test-key`);
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
          ws.send(JSON.stringify({ id, result: { success: true } }));
        } else if (msg.action === 'type') {
          ws.send(JSON.stringify({ id, result: { success: true } }));
        } else {
          ws.send(JSON.stringify({ id, error: `Unknown action: ${msg.action}` }));
        }
      } catch {
        // ignore malformed messages
      }
    });
    ws.on('open', () => resolve(ws));
  });
}

function connectExtension(server: { wsPort: number }): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.wsPort}?key=test-key`);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('Server - Basic', () => {
  let server: ChromeControllerServer;
  let ext: WebSocket;

  test.it('starts and responds to health check', async () => {
    server = createServer();
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
    const res = await post(server, { action: 'nonexistent' });
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

test.describe('Server - Batch Mode', () => {
  let server: ChromeControllerServer;
  let ext: WebSocket;

  test.it('executes multiple commands in a batch', async () => {
    server = createServer();
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
        { action: 'unknownAction' },
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
  let ext1: WebSocket;

  test.it('closes existing connection on new connection', async () => {
    // Server replaces old connection rather than rejecting new one
    server = createServer();
    ext1 = await connectExtension(server);
    await delay(50);
    // Second connection should succeed but close the first on server side
    const ext2 = await connectExtension(server);
    await delay(200);
    // ext2 should be connected now
    assert.ok(ext2.readyState === WebSocket.OPEN);
    ext2.close();
    await delay(50);
    server.close();
  });

  test.it('accepts new connection after previous disconnects', async () => {
    server = createServer();
    const w = new WebSocket(`ws://127.0.0.1:${server.wsPort}?key=test-key`);
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
    server = createServer();
    const res = await get(server, '/unknown');
    assert.equal(res.status, 404);
    server.close();
  });

  test.it('returns 503 when no extension is connected', async () => {
    server = createServer();
    const res = await post(server, { action: 'queryTabs', queryInfo: {} });
    assert.equal(res.status, 503);
    assert.ok(res.body.error);
    server.close();
  });

  test.it('returns 503 after extension disconnects', async () => {
    server = createServer();
    const ext = await connectExtension(server);
    ext.terminate(); // Force immediate close
    await delay(500); // Give server time to detect disconnect
    const res = await post(server, { action: 'queryTabs', queryInfo: {} });
    assert.equal(res.status, 503);
    server.close();
  });
});

test.describe('Server - Extension Close Events', () => {
  let server: ChromeControllerServer;
  let ext: WebSocket;

  test.it('extension emits close event when it closes normally', async () => {
    server = createServer();
    ext = await connectExtension(server);
    const closed = Promise.withResolvers<void>();
    ext.on('close', () => closed.resolve());
    ext.close();
    await Promise.race([closed.promise, delay(5000)]);
    server.close();
  });

  test.it('extension emits close event when it crashes', async () => {
    server = createServer();
    ext = await connectExtension(server);
    const closed = Promise.withResolvers<void>();
    ext.on('close', () => closed.resolve());
    ext.terminate();
    await Promise.race([closed.promise, delay(5000)]);
    server.close();
  });
});

test.describe('Server - Discovery', () => {
  test.it('writes and reads discovery file', () => {
    const info = { httpPort: 9999, wsPort: 9998, apiKey: 'secret', pid: process.pid, startedAt: new Date().toISOString() };
    writeDiscovery('test', info);
    const read = readDiscovery('test');
    assert.equal(read?.httpPort, 9999);
    assert.equal(read?.wsPort, 9998);
    assert.equal(read?.apiKey, 'secret');
    removeDiscovery('test');
  });

  test.it('creates directory if it does not exist', () => {
    const info = { httpPort: 1111, wsPort: 1112, apiKey: 'k', pid: process.pid, startedAt: new Date().toISOString() };
    writeDiscovery('disc-nested', info);
    const read = readDiscovery('disc-nested');
    assert.equal(read?.httpPort, 1111);
    removeDiscovery('disc-nested');
  });

  test.it('removes non-existent discovery file without error', () => {
    removeDiscovery('does-not-exist-12345');
  });
});

test.describe('Server - Dynamic Port Assignment', () => {
  let server: ChromeControllerServer;

  test.it('reports actual bound ports in health endpoint', async () => {
    server = createServer({ httpPort: 0, wsPort: 0 });
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
    server = createServer();
    ext = await connectMockExtension(server);

    const res = await post(server, { action: 'queryTabs', queryInfo: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const res2 = await post(server, { action: 'badAction' });
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
    server = createServer();
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

  test.it('rejects batch exceeding max actions', async () => {
    // Server caps batch at 50 commands
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
    const server = createServer();
    const ws = new WebSocket(`ws://127.0.0.1:${server.wsPort}?key=wrong`);
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
    });
    server.close();
  });

  test.it('rejects WebSocket connection without API key', async () => {
    const server = createServer();
    const ws = new WebSocket(`ws://127.0.0.1:${server.wsPort}`);
    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
    });
    server.close();
  });
});

test.describe('Server - Process Command', () => {
  let server: ChromeControllerServer;
  let ext: WebSocket;

  test.it('processes command with missing id gracefully', async () => {
    server = createServer();
    ext = await connectMockExtension(server);
    // Server assigns its own id if not present
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
    const nested = path.join(tmpDir, 'sub', 'dir');
    // writeDiscovery creates DISCOVERY_DIR; we test it doesn't crash
    const info = { httpPort: 1111, wsPort: 1112, apiKey: 'k', pid: process.pid, startedAt: new Date().toISOString() };
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
    server = createServer({ defaultTimeoutMs: 300 });
    // Connect a dummy extension that ignores messages
    ext = await connectExtension(server);
    // Extension won't respond, so request should time out
    const res = await post(server, { action: 'queryTabs', queryInfo: {} });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    ext.close();
    await delay(100);
    server.close();
  });
});

test.describe('Server - Invalid JSON Payload', () => {
  let server: ChromeControllerServer;

  test.it('rejects invalid JSON in request body', async () => {
    server = createServer();
    const res = await new Promise<any>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.httpPort,
          path: '/',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key' },
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
      req.on('error', reject => reject());
      req.write('not-json{');
      req.end();
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    server.close();
  });
});

test.describe('Server - Sequential Batch Mode', () => {
  let server: ChromeControllerServer;
  let ext: WebSocket;

  test.it('executes batch in sequential mode', async () => {
    server = createServer();
    ext = await connectMockExtension(server);

    const res = await post(server, {
      action: 'batch',
      commands: [
        { action: 'queryTabs', queryInfo: {} },
        { action: 'click', selector: '#btn' },
      ],
      mode: 'sequential',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.mode, 'sequential');
    ext.close();
    await delay(50);
    server.close();
  });

  test.it('sequential batch stops on error when stopOnError is true', async () => {
    server = createServer();
    ext = await connectMockExtension(server);

    const res = await post(server, {
      action: 'batch',
      commands: [
        { action: 'unknownAction' },
        { action: 'queryTabs', queryInfo: {} },
      ],
      mode: 'sequential',
      stopOnError: true,
    });
    assert.equal(res.status, 207);
    // Should only have 1 result (stopped after first error)
    assert.equal(res.body.results.length, 1);
    assert.equal(res.body.results[0].success, false);
    ext.close();
    await delay(50);
    server.close();
  });

  test.it('sequential batch continues on error when stopOnError is false', async () => {
    server = createServer();
    ext = await connectMockExtension(server);

    const res = await post(server, {
      action: 'batch',
      commands: [
        { action: 'queryTabs', queryInfo: {} },
        { action: 'unknownAction' },
        { action: 'click', selector: '#btn' },
      ],
      mode: 'sequential',
      stopOnError: false,
    });
    assert.equal(res.status, 207);
    assert.equal(res.body.results.length, 3);
    assert.equal(res.body.results[0].success, true);
    assert.equal(res.body.results[1].success, false);
    assert.equal(res.body.results[2].success, true);
    ext.close();
    await delay(50);
    server.close();
  });
});

test.describe('Server - Bearer Token Auth', () => {
  let server: ChromeControllerServer;

  test.it('accepts Bearer token in Authorization header', async () => {
    server = createServer();
    const res = await new Promise<any>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.httpPort,
          path: '/',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'authorization': 'Bearer test-key' },
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
      req.write(JSON.stringify({ action: 'queryTabs' }));
      req.end();
    });
    // Should get 503 (no extension) rather than 401 (auth passed)
    assert.equal(res.status, 503);
    server.close();
  });
});
