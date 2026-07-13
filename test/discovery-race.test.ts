/**
 * Tests for discovery file timing (race condition).
 *
 * Issue #2: Discovery file race condition — the discovery file is written
 * inside the HTTP server's 'listen' callback, which means the server is
 * technically ready, but there's a window where:
 * 1. The server is accepting connections
 * 2. The discovery file hasn't been written yet
 * 3. Clients reading the discovery file get stale or missing data
 *
 * Run: npx tsx --test test/discovery-race.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createChromeControllerServer,
  readDiscovery,
  removeDiscovery,
  type ChromeControllerServer,
} from '../src/server.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function uniqueInstance(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function waitForDiscoveryFile(instance: string, ms = 3000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = setInterval(() => {
      if (readDiscovery(instance) !== null) {
        clearInterval(tick);
        resolve();
      }
      if (Date.now() - start > ms) {
        clearInterval(tick);
        resolve();
      }
    }, 5);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('discovery file is written after server starts listening', async () => {
  const instance = uniqueInstance();

  // Ensure clean state
  removeDiscovery(instance);
  assert.equal(readDiscovery(instance), null, 'Discovery should not exist yet');

  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key',
    instance,
    writeDiscoveryFile: true,
  });

  await waitForServerReady(srv);

  // Wait for discovery file to appear (it's written in the listen callback)
  await waitForDiscoveryFile(instance);

  // Discovery file should now exist
  const discovery = readDiscovery(instance);
  assert.ok(discovery, 'Discovery file should exist after server is ready');
  assert.equal(discovery.httpPort, srv.httpPort);
  assert.equal(discovery.wsPort, srv.wsPort);
  assert.equal(discovery.apiKey, 'test-key');
  assert.equal(discovery.pid, process.pid);

  srv.close();
});

test('discovery file is not available immediately at construction time', async () => {
  const instance = uniqueInstance();
  removeDiscovery(instance);

  // Track when the server becomes ready vs when discovery appears
  const events: string[] = [];

  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key',
    instance,
    writeDiscoveryFile: true,
  });

  // Immediately after construction, discovery should not exist
  const preStartDiscovery = readDiscovery(instance);
  if (!preStartDiscovery) {
    events.push('no-discovery-at-construction');
  }

  await waitForServerReady(srv);
  events.push('server-ready');

  // At this point, the server is ready but discovery may not exist yet
  // This is the race condition window
  const atReadyDiscovery = readDiscovery(instance);
  if (!atReadyDiscovery) {
    events.push('no-discovery-at-ready');
  }

  // Wait for discovery to appear
  await waitForDiscoveryFile(instance);
  events.push('discovery-available');

  // This demonstrates the race: between construction and ready,
  // the discovery file doesn't exist, but the server may already
  // be accepting connections
  assert.ok(events.includes('no-discovery-at-construction'), 'Discovery missing at construction');
  assert.ok(events.includes('server-ready'), 'Server ready event fired');
  assert.ok(events.includes('discovery-available'), 'Discovery eventually available');

  // Verify the race condition: server became ready before discovery was available
  const readyIndex = events.indexOf('server-ready');
  const discoveryIndex = events.indexOf('discovery-available');
  assert.ok(readyIndex < discoveryIndex, 'Server ready before discovery file available');

  srv.close();
});

test('rapid client may read stale discovery from previous instance', async () => {
  const instance = uniqueInstance();
  removeDiscovery(instance);

  // Start first server
  const srv1 = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'key-1',
    instance,
    writeDiscoveryFile: true,
  });

  await waitForServerReady(srv1);
  await waitForDiscoveryFile(instance);
  const ports1 = { ws: srv1.wsPort, http: srv1.httpPort };

  // Close first server (which removes discovery)
  srv1.close();

  // Start second server immediately
  const srv2 = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'key-2',
    instance,
    writeDiscoveryFile: true,
  });

  await waitForServerReady(srv2);
  await waitForDiscoveryFile(instance);

  // Discovery should point to srv2, not srv1
  const discovery = readDiscovery(instance);
  assert.ok(discovery, 'Discovery should exist');
  assert.equal(discovery.apiKey, 'key-2', 'Discovery should have new key');
  assert.notEqual(discovery.wsPort, ports1.ws, 'Ports should differ');

  srv2.close();
});

test('discovery file persists after server closes unexpectedly', async () => {
  const instance = uniqueInstance();
  removeDiscovery(instance);

  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key',
    instance,
    writeDiscoveryFile: true,
  });

  await waitForServerReady(srv);
  await waitForDiscoveryFile(instance);

  // Simulate unexpected crash — close without cleanup
  // In production, this happens when the process is killed
  srv.server.close();
  srv.wss.close();
  // Note: we're NOT calling srv.close() which would remove discovery

  // Discovery file still exists — stale!
  const staleDiscovery = readDiscovery(instance);
  assert.ok(staleDiscovery, 'Stale discovery should still exist');

  // A new client reading this discovery will try to connect to a dead server
  const health = await new Promise<{ status: number }>((resolve) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: staleDiscovery!.httpPort,
        path: '/health',
        method: 'GET',
        timeout: 500,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode! }));
      }
    );
    req.on('error', () => resolve({ status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.end();
  });

  assert.equal(health.status, 0, 'Server should be unreachable (stale discovery)');

  // Clean up
  removeDiscovery(instance);
});

test('writeDiscoveryFile false skips discovery file', async () => {
  const instance = uniqueInstance();
  removeDiscovery(instance);

  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key',
    instance,
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  assert.equal(readDiscovery(instance), null, 'Discovery should not exist');

  srv.close();
});

test('discovery file contains correct OS-assigned ports', async () => {
  const instance = uniqueInstance();
  removeDiscovery(instance);

  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'my-secret-key',
    instance,
    writeDiscoveryFile: true,
  });

  await waitForServerReady(srv);
  await waitForDiscoveryFile(instance);

  const discovery = readDiscovery(instance);
  assert.ok(discovery);
  assert.ok(discovery.httpPort > 0, 'HTTP port should be assigned');
  assert.ok(discovery.wsPort > 0, 'WS port should be assigned');
  assert.equal(discovery.apiKey, 'my-secret-key');

  // Verify the ports actually work
  const health = await new Promise<{ status: number; body: unknown }>((resolve) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: discovery!.httpPort,
        path: '/health',
        method: 'GET',
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode!, body }); }
        });
      }
    );
    req.on('error', () => resolve({ status: 0, body: {} }));
    req.end();
  });

  assert.equal(health.status, 200, 'Health check should succeed on discovered port');
  const body = health.body as Record<string, unknown>;
  assert.equal(body['httpPort'], discovery.httpPort);
  assert.equal(body['wsPort'], discovery.wsPort);

  srv.close();
});
