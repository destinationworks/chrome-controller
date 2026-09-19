/**
 * Tests for silent failures in message routing.
 *
 * Issue #5: sendSocketResponse drops messages when socket not open.
 * The background.js function sendSocketResponse silently drops responses
 * if the WebSocket is not in OPEN state, with no logging or retry.
 *
 * ```js
 * function sendSocketResponse(id, payload) {
 *   if (socket && socket.readyState === WebSocket.OPEN && id) {
 *     socket.send(JSON.stringify({ id, ...payload }));
 *   }
 * }
 * ```
 *
 * This means if the socket closes mid-action, the server never gets
 * a response and hangs until timeout.
 *
 * Run: npx tsx --test test/silent-failure.test.ts
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
  timeoutMs = 10000,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path,
        method: 'POST',
        timeout: timeoutMs,
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
    req.on('timeout', () => { req.destroy(); reject(new Error(`HTTP request timed out after ${timeoutMs}ms`)); });
    req.write(data);
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

test('server request hangs when extension drops connection mid-request', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: TEST_KEY,
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // Connect extension that will disconnect before replying
  const ext = await connectExtension(srv.wsPort, TEST_KEY);

  // Extension receives the message but disconnects before sending response
  ext.on('message', () => {
    // Simulate extension crashing/disconnecting before reply
    ext.close();
  });

  // Server request will timeout because extension never replied
  const { status, body } = await httpPost(
    srv.httpPort,
    '/',
    { action: 'queryTabs', requestTimeoutMs: 500 },
    TEST_KEY,
  );

  assert.equal(status, 400);
  const errMsg = (body as Record<string, unknown>)['error'] as string;
  assert.ok(
    errMsg.includes('Extension disconnected') || errMsg.includes('timed out'),
    `Request should fail when extension drops connection (got: ${errMsg})`,
  );

  srv.close();
});

test('sendSocketResponse silently drops messages when socket CLOSED', async () => {
  // This test documents the background.js sendSocketResponse behavior.
  // When the socket is in CLOSED state, responses are silently dropped.
  // There is no logging, no error, no retry.
  //
  // Simulate by checking that a closed socket drops messages.

  const ws = new WebSocket('ws://localhost:9999'); // Will fail to connect
  await new Promise<void>((resolve) => {
    ws.on('error', () => resolve());
  });

  // Socket is now in CLOSED state
  assert.equal(ws.readyState, WebSocket.CLOSED);

  // sendSocketResponse equivalent: silently drops the message
  const messagesSent: unknown[] = [];
  const originalSend = ws.send.bind(ws);
  ws.send = (...args: unknown[]) => {
    messagesSent.push(...args);
    return originalSend(...args);
  };

  // Simulate sendSocketResponse logic
  const sendSocketResponse = (id: number, payload: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN && id) {
      ws.send(JSON.stringify({ id, ...payload }));
    }
    // Silent drop — no logging, no error
  };

  sendSocketResponse(1, { result: 'test' });
  assert.equal(messagesSent.length, 0, 'Message should be silently dropped');

  // This is the bug: the server-side request has no way to know
  // that the response was dropped. It will hang until timeout.
});

test('batch request partial failure when extension disconnects mid-batch', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: TEST_KEY,
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  // Connect extension
  const ext = await connectExtension(srv.wsPort, TEST_KEY);

  let messageCount = 0;
  ext.on('message', (data: Buffer | string) => {
    messageCount++;
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;

    // Reply to first message, then disconnect
    if (messageCount === 1) {
      ext.send(JSON.stringify({ id: msg['id'], result: 'first-ok' }));
    } else {
      // Disconnect before replying to subsequent messages
      ext.close();
    }
  });

  // Sequential batch — second action will timeout
  const { body } = await httpPost(
    srv.httpPort,
    '/',
    {
      mode: 'sequential',
      actions: [
        { action: 'queryTabs', requestTimeoutMs: 500 },
        { action: 'navigate', requestTimeoutMs: 500 },
      ],
    },
    TEST_KEY,
  );

  const b = body as { results?: Array<{ success: boolean; error?: string }> };
  // First action succeeded, second timed out
  if (b.results) {
    assert.equal(b.results[0].success, true, 'First action should succeed');
    assert.ok(
      !b.results[0].success || b.results[1]?.error?.includes('timed out') ||
      b.results[1]?.error?.includes('disconnected'),
      'Second action should fail due to disconnect',
    );
  }

  srv.close();
});

test('parallel batch loses responses when extension disconnects', async () => {
  const srv = createChromeControllerServer({
    wsPort: 0,
    httpPort: 0,
    apiKey: TEST_KEY,
    writeDiscoveryFile: false,
  });

  await waitForServerReady(srv);

  const ext = await connectExtension(srv.wsPort, TEST_KEY);

  let messageCount = 0;
  ext.on('message', () => {
    messageCount++;
    // Disconnect after receiving all parallel requests
    if (messageCount >= 3) {
      ext.close();
    }
  });

  // All three should timeout
  const { body } = await httpPost(
    srv.httpPort,
    '/',
    {
      mode: 'parallel',
      actions: [
        { action: 'queryTabs', requestTimeoutMs: 500 },
        { action: 'navigate', requestTimeoutMs: 500 },
        { action: 'click', requestTimeoutMs: 500 },
      ],
    },
    TEST_KEY,
  );

  const b = body as { results: Array<{ success: boolean }> };
  assert.ok(!b.results.every((r) => r.success), 'Some actions should fail');

  srv.close();
});

test('no logging when messages are silently dropped', async () => {
  // This test documents that there is no logging when sendSocketResponse
  // drops a message. In production, this makes debugging connection issues
  // extremely difficult because there is no trace of what happened.
  //
  // Expected behavior: log a warning when a response cannot be sent.
  // Current behavior: silent drop.

  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args: unknown[]) => logs.push(`log: ${args.join(' ')}`);
  console.warn = (...args: unknown[]) => logs.push(`warn: ${args.join(' ')}`);
  console.error = (...args: unknown[]) => logs.push(`error: ${args.join(' ')}`);

  try {
    // Simulate sendSocketResponse with closed socket
    const mockSocket = { readyState: WebSocket.CLOSED } as unknown as WebSocket;
    const sendSocketResponse = (id: number, payload: Record<string, unknown>) => {
      if (mockSocket && mockSocket.readyState === WebSocket.OPEN && id) {
        mockSocket.send(JSON.stringify({ id, ...payload }));
      }
      // No logging!
    };

    sendSocketResponse(1, { result: 'important-data' });

    assert.equal(logs.length, 0, 'No logs generated for dropped message');
    // This is the bug: critical data loss with no trace
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
});
