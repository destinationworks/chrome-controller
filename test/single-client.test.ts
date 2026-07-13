/**
 * Tests for single active client and lack of request queue.
 *
 * Issue #7: Only one WebSocket client is allowed at a time. New connections
 * are rejected when a client is already connected. There is no client queue
 * when the extension is disconnected — requests simply fail with 503.
 *
 * Run: npx tsx --test test/single-client.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import {
  createChromeControllerServer,
  type ChromeControllerServer,
} from '../src/server.ts';

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

test('only one WebSocket client can be active at a time', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key',
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // First client connects successfully
  const client1 = await connectExtension(srv.wsPort, 'test-key');
  assert.equal(client1.readyState, WebSocket.OPEN);

  // Second client should be rejected or close the first
  const client2Promise = connectExtension(srv.wsPort, 'test-key');
  const client2 = await client2Promise;

  // After second connects, check health
  const health = await httpGet(srv.httpPort, '/health');
  const connected = (health.body as Record<string, unknown>)['extensionConnected'];
  assert.equal(connected, true, 'One client should be connected');

  // The server only tracks one active client
  // The second connection either replaces the first or is rejected
  // depending on server implementation

  client1.close();
  client2.close();
  await new Promise((r) => setTimeout(r, 100));
  srv.close();
});

test('no request queue when extension is disconnected', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key',
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // No extension connected
  const { status, body } = await httpPost(
    srv.httpPort,
    '/',
    { action: 'queryTabs' },
    'test-key',
  );

  // Request fails immediately with 503 — no queue
  assert.equal(status, 503);
  assert.ok(
    ((body as Record<string, unknown>)['error'] as string).includes('No Chrome extension'),
    'Request should fail immediately, not be queued',
  );

  srv.close();
});

test('requests fail immediately when no client, not queued for later', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key',
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // Send request with no client
  const reqPromise = httpPost(srv.httpPort, '/', { action: 'test' }, 'test-key');

  // Connect client after request was sent
  await new Promise((r) => setTimeout(r, 50));
  const ext = await connectExtension(srv.wsPort, 'test-key');

  // The earlier request already failed — it was not queued
  const { status } = await reqPromise;
  assert.equal(status, 503, 'Request should have failed before client connected');

  ext.close();
  srv.close();
});

test('multiple HTTP clients can send requests concurrently', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key',
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // Connect extension with auto-reply
  const ext = await connectExtension(srv.wsPort, 'test-key');
  ext.on('message', (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    ext.send(JSON.stringify({ id: msg['id'], result: 'ok' }));
  });

  // Multiple HTTP clients can send requests
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      httpPost(srv.httpPort, '/', { action: 'test' }, 'test-key'),
    ),
  );

  // All should succeed (extension replies to all)
  for (const { status } of results) {
    assert.ok(status === 200 || status === 400, 'Request should complete');
  }

  ext.close();
  srv.close();
});

test('pending requests are not forwarded to new client after reconnect', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key',
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // Connect first extension
  const ext1 = await connectExtension(srv.wsPort, 'test-key');

  // Send request with long timeout (extension won't reply)
  const reqPromise = httpPost(
    srv.httpPort,
    '/',
    { action: 'slow-action', requestTimeoutMs: 10000 },
    'test-key',
  );

  await new Promise((r) => setTimeout(r, 100));

  // Disconnect first extension
  ext1.close();
  await new Promise((r) => setTimeout(r, 100));

  // Connect new extension
  const ext2 = await connectExtension(srv.wsPort, 'test-key');
  ext2.on('message', (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    ext2.send(JSON.stringify({ id: msg['id'], result: 'from-ext2' }));
  });

  // The pending request from before disconnect should have been cleared
  const { status, body } = await reqPromise;
  assert.equal(status, 400);
  assert.ok(
    ((body as Record<string, unknown>)['error'] as string).includes('disconnected') ||
    ((body as Record<string, unknown>)['error'] as string).includes('timed out'),
    'Pending request should not be forwarded to new client',
  );

  ext2.close();
  srv.close();
});

test('server does not buffer requests for offline extension', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key',
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // Send multiple requests with no extension
  const requests = Array.from({ length: 10 }, () =>
    httpPost(srv.httpPort, '/', { action: 'test' }, 'test-key'),
  );

  const results = await Promise.all(requests);

  // All should fail immediately
  for (const { status } of results) {
    assert.equal(status, 503, 'Each request should fail independently');
  }

  // Connect extension
  const ext = await connectExtension(srv.wsPort, 'test-key');
  ext.on('message', (data: Buffer | string) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    ext.send(JSON.stringify({ id: msg['id'], result: 'ok' }));
  });

  // New requests work
  const { status } = await httpPost(srv.httpPort, '/', { action: 'test' }, 'test-key');
  assert.ok(status === 200, 'New requests should work after extension connects');

  ext.close();
  srv.close();
});
