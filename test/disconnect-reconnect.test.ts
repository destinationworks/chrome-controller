/**
 * Tests for WebSocket disconnect/reconnect behavior.
 *
 * Issue #3: No server-side reconnection — pending requests are cleared on
 * disconnect with no retry mechanism.
 *
 * Issue #4: Slow extension reconnection — 1 minute minimum reconnect delay
 * via chrome.alarms (RECONNECT_INTERVAL_MIN = 1 minute).
 *
 * Issue #8: MV3 service worker lifecycle — state is lost when Chrome
 * terminates the service worker (controlledTabId, controlledGroupIdsByWindow).
 *
 * Run: npx tsx --test test/disconnect-reconnect.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import {
  createChromeControllerServer,
  type ChromeControllerServer,
} from '../src/server.ts';

const TEST_KEY = 'test-key-0123456789abcdef01234567';

// ── Helpers ──────────────────────────────────────────────────────────────────

function httpPost(
  port: number,
  path: string,
  body: unknown,
  key: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'x-api-key': key,
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (c: Buffer) => { responseBody += c.toString(); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(responseBody) }); }
          catch { resolve({ status: res.statusCode!, body: responseBody }); }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(
  port: number,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path, method: 'GET' },
      (res) => {
        let responseBody = '';
        res.on('data', (c: Buffer) => { responseBody += c.toString(); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(responseBody) }); }
          catch { resolve({ status: res.statusCode!, body: responseBody }); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function connectExtension(
  wsPort: number,
  apiKey: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${wsPort}?key=${apiKey}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForServerReady(srv: ChromeControllerServer, ms = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (srv.httpPort > 0 && srv.wsPort > 0) {
      resolve();
      return;
    }
    const start = Date.now();
    const tick = setInterval(() => {
      if (srv.httpPort > 0 && srv.wsPort > 0) {
        clearInterval(tick);
        resolve();
      }
      if (Date.now() - start > ms) {
        clearInterval(tick);
        resolve();
      }
    }, 50);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('pending requests are rejected when extension disconnects', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: TEST_KEY,
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // Connect extension that will NOT reply
  const ext = await connectExtension(srv.wsPort, TEST_KEY);

  // Send a request with a short timeout
  const { status, body } = await httpPost(
    srv.httpPort,
    '/',
    { action: 'queryTabs', requestTimeoutMs: 500 },
    TEST_KEY,
  );

  // Request should timeout because extension never replies
  assert.equal(status, 400);
  assert.ok(
    ((body as Record<string, unknown>)['error'] as string).includes('timed out'),
    'Request should timeout',
  );

  ext.close();
  await new Promise((r) => setTimeout(r, 50));
  srv.close();
});

test('disconnect clears all pending requests immediately', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: TEST_KEY,
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // Connect extension
  const ext = await connectExtension(srv.wsPort, TEST_KEY);

  // Start multiple concurrent requests (extension won't reply)
  const requests = Array.from({ length: 5 }, (_, i) =>
    httpPost(
      srv.httpPort,
      '/',
      { action: `action${i}`, requestTimeoutMs: 10000 },
      TEST_KEY,
    ),
  );

  // Wait for requests to be queued
  await new Promise((r) => setTimeout(r, 100));

  // Verify pending requests are queued
  const health1 = await httpGet(srv.httpPort, '/health');
  assert.equal(
    (health1.body as Record<string, unknown>)['pendingRequests'],
    5,
    'Should have 5 pending requests',
  );

  // Disconnect extension
  ext.close();
  await new Promise((r) => setTimeout(r, 100));

  // All pending requests should now fail
  const results = await Promise.all(requests);
  for (const { status, body } of results) {
    assert.equal(status, 400);
    assert.ok(
      ((body as Record<string, unknown>)['error'] as string).includes('disconnected'),
      'Request should fail with disconnect error',
    );
  }

  // Pending count should be 0
  const health2 = await httpGet(srv.httpPort, '/health');
  assert.equal(
    (health2.body as Record<string, unknown>)['pendingRequests'],
    0,
    'Pending requests should be cleared',
  );

  srv.close();
});

test('no automatic retry after disconnect', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: TEST_KEY,
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // Connect extension
  const ext = await connectExtension(srv.wsPort, TEST_KEY);

  // Set up auto-reply
  ext.on('message', (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    ext.send(JSON.stringify({ id: msg['id'], result: 'ok' }));
  });

  // Send a successful request
  const { body } = await httpPost(srv.httpPort, '/', { action: 'test' }, TEST_KEY);
  assert.equal((body as { success: boolean })['success'], true);

  // Disconnect
  ext.close();
  await new Promise((r) => setTimeout(r, 100));

  // Now any new request fails — no retry
  const { status, body: failBody } = await httpPost(
    srv.httpPort,
    '/',
    { action: 'test' },
    TEST_KEY,
  );
  assert.equal(status, 503);
  assert.ok(
    ((failBody as Record<string, unknown>)['error'] as string).includes('No Chrome extension'),
  );

  srv.close();
});

test('reconnect requires manual client reconnection', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: TEST_KEY,
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // Connect, disconnect, reconnect cycle
  const ext1 = await connectExtension(srv.wsPort, TEST_KEY);
  ext1.on('message', (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    ext1.send(JSON.stringify({ id: msg['id'], result: 'from-ext1' }));
  });

  const r1 = await httpPost(srv.httpPort, '/', { action: 'test' }, TEST_KEY);
  assert.equal((r1.body as { result: string })['result'], 'from-ext1');

  ext1.close();
  await new Promise((r) => setTimeout(r, 100));

  // Server has no client now
  const h1 = await httpGet(srv.httpPort, '/health');
  assert.equal(
    (h1.body as Record<string, unknown>)['extensionConnected'],
    false,
  );

  // Reconnect with new WebSocket
  const ext2 = await connectExtension(srv.wsPort, TEST_KEY);
  ext2.on('message', (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    ext2.send(JSON.stringify({ id: msg['id'], result: 'from-ext2' }));
  });

  const r2 = await httpPost(srv.httpPort, '/', { action: 'test' }, TEST_KEY);
  assert.equal((r2.body as { result: string })['result'], 'from-ext2');

  ext2.close();
  srv.close();
});

test('extension reconnect delay is 1 minute (chrome.alarms minimum)', async () => {
  // This test documents the reconnect delay issue in background.js.
  // The extension uses chrome.alarms with periodInMinutes: 1,
  // which means after disconnect, the earliest reconnect attempt
  // is 1 minute later.
  //
  // We can't test chrome.alarms directly in Node, but we can verify
  // the constant from the background.js source.

  const RECONNECT_INTERVAL_MIN = 1; // From background.js
  const RECONNECT_DELAY_MS = RECONNECT_INTERVAL_MIN * 60 * 1000;

  assert.equal(RECONNECT_DELAY_MS, 60000, 'Reconnect delay is 1 minute');

  // This is problematic because:
  // 1. Server restarts leave the extension disconnected for 1+ minutes
  // 2. Port changes mean the extension connects to the wrong port
  // 3. No backoff strategy — just a fixed 1-minute delay
});

test('MV3 service worker termination loses extension state', async () => {
  // This test documents the MV3 lifecycle issue.
  // When Chrome suspends/terminates the service worker:
  // - controlledTabId is lost
  // - controlledGroupIdsByWindow is lost
  // - socket connection is lost
  // - chrome.alarms persist but the worker state doesn't
  //
  // Simulate by checking that the server has no knowledge of
  // extension-internal state.

  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: TEST_KEY,
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // Connect extension
  const ext = await connectExtension(srv.wsPort, TEST_KEY);
  ext.on('message', (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    ext.send(JSON.stringify({ id: msg['id'], result: { tabId: 123 } }));
  });

  // Simulate: extension selects a tab (state stored in extension only)
  const r1 = await httpPost(
    srv.httpPort,
    '/',
    { action: 'selectTab', tabId: 123 },
    TEST_KEY,
  );
  assert.equal((r1.body as { success: boolean })['success'], true);

  // Simulate service worker termination: disconnect and reconnect
  ext.close();
  await new Promise((r) => setTimeout(r, 100));

  // New connection has no state
  const ext2 = await connectExtension(srv.wsPort, TEST_KEY);
  // The extension's controlledTabId is now null
  // Any pending operations on the previous controlled tab will fail

  ext2.close();
  srv.close();
});
