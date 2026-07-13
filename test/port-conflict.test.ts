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
    srv.listen(port, () => resolvePromise(srv));
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
    apiKey: 'test-key',
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
    const wss = new WebSocketServer({ port: blockedPort });
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

test('createChromeControllerServer has no error handler on WSS (crash gap)', async () => {
  // This test verifies the root cause: the WSS created inside
  // createChromeControllerServer has no 'error' listener attached.
  // We can't easily inspect the internal WSS, so we verify by behavior:
  // when the WS port is blocked, the process crashes (tested via subprocess).

  const blocker = await bindPort(0);
  const addr = blocker.address() as { port: number };
  const blockedPort = addr.port;

  const result = spawnServerWithBlockedPort(blockedPort);

  // The process should crash with a non-zero exit code
  assert.ok(
    result.exitCode !== 0,
    `Expected non-zero exit code, got: ${result.exitCode}. Stderr: ${result.stderr}`,
  );

  // The stderr should contain EADDRINUSE
  assert.ok(
    result.stderr.includes('EADDRINUSE'),
    `Expected EADDRINUSE in stderr, got: ${result.stderr}`,
  );

  blocker.close();
});

test('two servers on same fixed port cause crash on second server', async () => {
  // First server takes dynamic ports
  const srv1 = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: 'test-key-1',
    writeDiscoveryFile: false,
  });

  await waitForReady(srv1);
  const wsPort = srv1.wsPort;

  // Second server tries the same WS port — crashes in subprocess
  const result = spawnServerWithBlockedPort(wsPort);

  assert.ok(
    result.exitCode !== 0,
    `Second server should crash, got exit code: ${result.exitCode}. Stderr: ${result.stderr}`,
  );
  assert.ok(
    result.stderr.includes('EADDRINUSE'),
    `Expected EADDRINUSE in stderr, got: ${result.stderr}`,
  );

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

test('server should detect and report port conflicts gracefully', async () => {
  // This test documents the expected behavior that is currently missing.
  // The server should:
  // 1. Catch EADDRINUSE on both WSS and HTTP server
  // 2. Log a clear error message with the conflicting port
  // 3. Optionally fall back to port 0 (OS-assigned)
  // 4. Never crash the process

  const blocker = await bindPort(0);
  const addr = blocker.address() as { port: number };
  const blockedPort = addr.port;

  // Current behavior: subprocess crashes with raw EADDRINUSE
  const result = spawnServerWithBlockedPort(blockedPort);

  // The error is raw EADDRINUSE, not a wrapped/descriptive error
  assert.ok(
    result.exitCode !== 0,
    'Should crash (no error handler)',
  );
  assert.ok(
    !result.stderr.includes('port already in use') &&
    !result.stderr.includes('Port conflict'),
    'Error message should be more descriptive (currently raw EADDRINUSE)',
  );

  blocker.close();

  // This assertion documents the gap: there is no graceful port conflict detection.
  assert.ok(true, 'Port conflict detection is not implemented');
});
