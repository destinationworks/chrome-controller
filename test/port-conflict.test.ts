/**
 * Tests for port conflict (EADDRINUSE) handling.
 *
 * Issue #6: No port conflict detection & no EADDRINUSE handler.
 * The WebSocketServer emits an 'error' event asynchronously when the port
 * is already bound, but createChromeControllerServer attaches no handler,
 * so it becomes an uncaught exception that crashes the process.
 *
 * Run: npx tsx --test test/port-conflict.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createChromeControllerServer,
  type ChromeControllerServer,
} from '../src/server.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Bind a raw TCP listener to a port so it appears occupied. */
function bindPort(port: number): Promise<http.Server> {
  return new Promise((resolvePromise) => {
    const srv = http.createServer();
    srv.listen(port, '127.0.0.1', () => resolvePromise(srv));
  });
}

/** Wait for a server to be ready (ports resolved). */
function waitForReady(srv: ChromeControllerServer, ms = 2000): Promise<void> {
  return new Promise((resolvePromise) => {
    if (srv.httpPort > 0 && srv.wsPort > 0) {
      resolvePromise();
      return;
    }
    const start = Date.now();
    const tick = setInterval(() => {
      if (srv.httpPort > 0 && srv.wsPort > 0) {
        clearInterval(tick);
        resolvePromise();
      }
      if (Date.now() - start > ms) {
        clearInterval(tick);
        resolvePromise();
      }
    }, 50);
  });
}

/**
 * Spawn a subprocess that calls createChromeControllerServer with a blocked WS port.
 * Uses the local tsx binary directly instead of npx.
 */
function spawnServerWithBlockedPort(blockedPort: number): {
  exitCode: number | null;
  stdout: string;
  stderr: string;
} {
  const script = resolve(__dirname, 'spawn-server.ts');
  const tsxBin = resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');

  const result = spawnSync(
    tsxBin,
    [script, String(blockedPort)],
    {
      cwd: resolve(__dirname, '..'),
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('server starts on port 0 without conflicts', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key-0123456789abcdef01234567',
    writeDiscoveryFile: false,
  });

  await waitForReady(srv);
  assert.ok(srv.wsPort > 0, 'WS port should be assigned by OS');
  assert.ok(srv.httpPort > 0, 'HTTP port should be assigned by OS');

  srv.close();
});

test('WebSocketServer emits EADDRINUSE error event (not synchronous throw) when port is occupied', async () => {
  const blocker = await bindPort(0);
  const addr = blocker.address() as { port: number };
  const blockedPort = addr.port;

  // WSS emits 'error' event asynchronously (not a synchronous throw)
  const errorPromise = new Promise<NodeJS.ErrnoException>((resolvePromise) => {
    const wss = new WebSocketServer({ port: blockedPort, host: '127.0.0.1' });
    wss.on('error', (e) => {
      wss.close();
      resolvePromise(e as NodeJS.ErrnoException);
    });
  });

  const error = await errorPromise;
  assert.equal(
    error.code,
    'EADDRINUSE',
    `Expected EADDRINUSE, got: ${error.code} ${error.message}`,
  );

  blocker.close();
});

test('createChromeControllerServer reports a blocked WebSocket port without an uncaught crash', async () => {

  const blocker = await bindPort(0);
  const addr = blocker.address() as { port: number };
  const blockedPort = addr.port;

  const result = spawnServerWithBlockedPort(blockedPort);

  assert.equal(result.exitCode, 2, `Expected handled startup failure, got: ${result.exitCode}`);
  assert.match(result.stderr, /Port conflict:.*port .* already in use/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);

  blocker.close();
});

test('two servers on the same fixed port reject the second startup cleanly', async () => {
  // First server takes dynamic ports
  const srv1 = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key-one-0123456789abcdef0123',
    writeDiscoveryFile: false,
  });

  await waitForReady(srv1);
  const wsPort = srv1.wsPort;

  // Second server tries the same WS port and reports a handled startup failure.
  const result = spawnServerWithBlockedPort(wsPort);

  assert.equal(result.exitCode, 2, `Second server should fail startup cleanly: ${result.stderr}`);
  assert.match(result.stderr, /Port conflict:.*port .* already in use/);

  // Verify first server still works
  const health = await new Promise<{ status: number; body: unknown }>((resolvePromise) => {
    const req = http.request(
      { hostname: 'localhost', port: srv1.httpPort, path: '/health', method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => {
          try { resolvePromise({ status: res.statusCode!, body: JSON.parse(body) }); }
          catch { resolvePromise({ status: res.statusCode!, body }); }
        });
      },
    );
    req.on('error', () => resolvePromise({ status: 0, body: {} }));
    req.end();
  });

  assert.equal(health.status, 200, 'First server should still be healthy');

  srv1.close();
});

test('server detects and reports port conflicts descriptively', async () => {

  const blocker = await bindPort(0);
  const addr = blocker.address() as { port: number };
  const blockedPort = addr.port;

  const result = spawnServerWithBlockedPort(blockedPort);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Port conflict/);
  assert.match(result.stderr, /WebSocket port .* is already in use/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);

  blocker.close();
});
