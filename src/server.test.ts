/**
 * Integration tests for the Chrome Controller WebSocket/HTTP server.
 *
 * Spins up an isolated server instance per test suite using createChromeControllerServer(),
 * then uses a mock WebSocket client to simulate the Chrome extension.
 *
 * Run: npx tsx --test src/server.test.ts
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createChromeControllerServer, type ChromeControllerServer } from './server.ts';

const HTTP_PORT = 19898;
const WS_PORT = 19899;
const API_KEY = 'test-api-key-12345';

let srv: ChromeControllerServer;

before(() => {
  srv = createChromeControllerServer({ httpPort: HTTP_PORT, wsPort: WS_PORT, apiKey: API_KEY });
});

after(() => {
  srv.close();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function httpPost(path: string, body: unknown, key?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port: HTTP_PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(key ? { 'x-api-key': key } : {}),
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (c: Buffer) => { responseBody += c.toString(); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(responseBody) }); }
          catch { resolve({ status: res.statusCode!, body: responseBody }); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: HTTP_PORT, path, method: 'GET' }, (res) => {
      let responseBody = '';
      res.on('data', (c: Buffer) => { responseBody += c.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(responseBody) }); }
        catch { resolve({ status: res.statusCode!, body: responseBody }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function connectMockExtension(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}?key=${API_KEY}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function autoReply(ext: WebSocket, resultFn: (msg: Record<string, unknown>) => unknown) {
  ext.on('message', (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    ext.send(JSON.stringify({ id: msg['id'], result: resultFn(msg) }));
  });
}

function autoError(ext: WebSocket, errorMsg: string) {
  ext.on('message', (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    ext.send(JSON.stringify({ id: msg['id'], error: errorMsg }));
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('GET /health returns server status', async () => {
  const { status, body } = await httpGet('/health');
  assert.equal(status, 200);
  const b = body as Record<string, unknown>;
  assert.equal(b['success'], true);
  assert.equal(b['extensionConnected'], false);
  assert.equal(b['httpPort'], HTTP_PORT);
  assert.equal(b['wsPort'], WS_PORT);
});

test('POST without API key returns 401', async () => {
  const { status, body } = await httpPost('/', { action: 'queryTabs' });
  assert.equal(status, 401);
  assert.equal((body as Record<string, unknown>)['success'], false);
});

test('POST with valid key but no extension returns 503', async () => {
  const { status, body } = await httpPost('/', { action: 'queryTabs' }, API_KEY);
  assert.equal(status, 503);
  assert.ok(((body as Record<string, unknown>)['error'] as string).includes('No Chrome extension'));
});

test('POST without action field returns 400', async () => {
  const { status, body } = await httpPost('/', {}, API_KEY);
  assert.equal(status, 400);
  assert.equal((body as Record<string, unknown>)['success'], false);
});

test('unknown route returns 404', async () => {
  const { status } = await httpGet('/unknown');
  assert.equal(status, 404);
});

test('extension connects and health shows connected', async () => {
  const ext = await connectMockExtension();
  const { body } = await httpGet('/health');
  assert.equal((body as Record<string, unknown>)['extensionConnected'], true);
  ext.close();
  // Allow disconnect event to propagate
  await new Promise((r) => setTimeout(r, 50));
});

test('extension replies successfully to a command', async () => {
  const ext = await connectMockExtension();
  autoReply(ext, (msg) => ({ tabs: ['tab1', 'tab2'], action: msg['action'] }));

  const { status, body } = await httpPost('/', { action: 'queryTabs' }, API_KEY);
  assert.equal(status, 200);
  const b = body as { success: boolean; result: { tabs: string[] } };
  assert.equal(b.success, true);
  assert.deepEqual(b.result.tabs, ['tab1', 'tab2']);

  ext.close();
  await new Promise((r) => setTimeout(r, 50));
});

test('extension error response propagates as HTTP 400', async () => {
  const ext = await connectMockExtension();
  autoError(ext, 'tab not found');

  const { status, body } = await httpPost('/', { action: 'selectTab', tabId: 99999 }, API_KEY);
  assert.equal(status, 400);
  const b = body as { success: boolean; error: string };
  assert.equal(b.success, false);
  assert.ok(b.error.includes('tab not found'));

  ext.close();
  await new Promise((r) => setTimeout(r, 50));
});

test('batch parallel mode returns combined results', async () => {
  const ext = await connectMockExtension();
  autoReply(ext, (msg) => ({ action: msg['action'] }));

  const { status, body } = await httpPost(
    '/',
    { mode: 'parallel', actions: [{ action: 'queryTabs' }, { action: 'createTab', url: 'https://example.com' }] },
    API_KEY
  );
  assert.equal(status, 200);
  const b = body as { success: boolean; mode: string; results: Array<{ success: boolean }> };
  assert.equal(b.success, true);
  assert.equal(b.mode, 'parallel');
  assert.equal(b.results.length, 2);
  assert.ok(b.results.every((r) => r.success));

  ext.close();
  await new Promise((r) => setTimeout(r, 50));
});

test('batch sequential mode stops on first error', async () => {
  const ext = await connectMockExtension();
  let callCount = 0;
  ext.on('message', (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    callCount++;
    if (callCount === 1) {
      ext.send(JSON.stringify({ id: msg['id'], error: 'first fails' }));
    } else {
      ext.send(JSON.stringify({ id: msg['id'], result: 'ok' }));
    }
  });

  const { body } = await httpPost(
    '/',
    { mode: 'sequential', actions: [{ action: 'actionA' }, { action: 'actionB' }, { action: 'actionC' }] },
    API_KEY
  );
  const b = body as { results: Array<{ success: boolean }> };
  assert.equal(b.results.length, 1);
  assert.equal(b.results[0].success, false);
  assert.equal(callCount, 1);

  ext.close();
  await new Promise((r) => setTimeout(r, 50));
});

test('batch rejects empty actions array', async () => {
  const { status, body } = await httpPost('/', { actions: [] }, API_KEY);
  assert.equal(status, 400);
  assert.ok(((body as Record<string, unknown>)['error'] as string).includes('cannot be empty'));
});

test('batch rejects more than max actions', async () => {
  const actions = Array.from({ length: 51 }, (_, i) => ({ action: `a${i}` }));
  const { status, body } = await httpPost('/', { actions }, API_KEY);
  assert.equal(status, 400);
  assert.ok(((body as Record<string, unknown>)['error'] as string).includes('more than'));
});
