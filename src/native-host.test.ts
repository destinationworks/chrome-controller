/**
 * Unit tests for the Native Messaging host (src/native-host.ts).
 *
 * Run: npx tsx --test src/native-host.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {
  getSocketPath,
  ensureSocketDir,
  cleanupStaleSocket,
  NativeMessagingHost,
} from './native-host.js';

test('getSocketPath returns per-user private path', () => {
  const origSocket = process.env.CHROME_CONTROLLER_SOCKET;
  delete process.env.CHROME_CONTROLLER_SOCKET;

  try {
    const socketPath = getSocketPath();
    if (process.platform === 'win32') {
      assert.strictEqual(socketPath, '\\\\.\\pipe\\chrome-controller-ipc');
    } else {
      assert.ok(socketPath.includes('.chrome-controller/run') || socketPath.includes('run.sock'));
    }
  } finally {
    if (origSocket !== undefined) process.env.CHROME_CONTROLLER_SOCKET = origSocket;
    else delete process.env.CHROME_CONTROLLER_SOCKET;
  }
});

test('getSocketPath respects CHROME_CONTROLLER_SOCKET env var', () => {
  const origSocket = process.env.CHROME_CONTROLLER_SOCKET;
  const customPath = '/tmp/custom-test-socket.sock';
  process.env.CHROME_CONTROLLER_SOCKET = customPath;

  try {
    assert.strictEqual(getSocketPath(), customPath);
  } finally {
    if (origSocket !== undefined) process.env.CHROME_CONTROLLER_SOCKET = origSocket;
    else delete process.env.CHROME_CONTROLLER_SOCKET;
  }
});

test('ensureSocketDir creates parent directory with 0700 permissions', () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'socket-dir-test-'));
  const testSocket = path.join(tmpBase, 'subdir', 'test.sock');

  try {
    ensureSocketDir(testSocket);
    assert.ok(fs.existsSync(path.dirname(testSocket)));
    const stats = fs.statSync(path.dirname(testSocket));
    assert.strictEqual((stats.mode & 0o777), 0o700);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('cleanupStaleSocket safely removes existing socket', () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'socket-clean-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');

  // Create dummy stale socket file
  fs.writeFileSync(testSocket, 'stale');

  assert.ok(fs.existsSync(testSocket));
  cleanupStaleSocket(testSocket);
  assert.ok(!fs.existsSync(testSocket));

  assert.doesNotThrow(() => cleanupStaleSocket(testSocket));

  fs.rmSync(tmpBase, { recursive: true, force: true });
});

test('NativeMessagingHost formats length-prefixed stdout frames', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-frame-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');

  const host = new NativeMessagingHost(testSocket);
  await host.ready;

  let capturedData = Buffer.alloc(0);
  const origWrite = process.stdout.write.bind(process.stdout);
  // @ts-expect-error Mocking stdout write for testing
  process.stdout.write = (chunk: Buffer | Uint8Array | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    capturedData = Buffer.concat([capturedData, buf]);
    return true;
  };

  try {
    const payload = { action: 'testAction', foo: 'bar' };
    host.sendToChrome(payload);

    assert.ok(capturedData.length >= 4);
    const length = capturedData.readUInt32LE(0);
    const body = JSON.parse(capturedData.subarray(4, 4 + length).toString('utf8'));
    assert.deepStrictEqual(body, payload);
  } finally {
    process.stdout.write = origWrite;
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost parses fragmented incoming stream frames', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-stream-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');

  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  const received: unknown[] = [];

  // Override handleMessageFromChrome to capture parsed messages
  // @ts-expect-error Access private method for testing
  host.handleMessageFromChrome = (msg: unknown) => {
    received.push(msg);
  };

  try {
    const msg1 = { id: 101, result: { success: true } };
    const msg2 = { id: 102, result: { value: 'chunked-data' } };

    const body1 = Buffer.from(JSON.stringify(msg1), 'utf8');
    const header1 = Buffer.alloc(4);
    header1.writeUInt32LE(body1.length, 0);
    const full1 = Buffer.concat([header1, body1]);

    const body2 = Buffer.from(JSON.stringify(msg2), 'utf8');
    const header2 = Buffer.alloc(4);
    header2.writeUInt32LE(body2.length, 0);
    const full2 = Buffer.concat([header2, body2]);

    const stream = Buffer.concat([full1, full2]);

    // Feed the stream in 3-byte chunks to test fragmentation
    for (let i = 0; i < stream.length; i += 3) {
      const chunk = stream.subarray(i, Math.min(i + 3, stream.length));
      // @ts-expect-error Access private field for testing
      host.buffer = Buffer.concat([host.buffer, chunk]);
      // @ts-expect-error Access private method for testing
      host.processBuffer();
    }

    assert.strictEqual(received.length, 2);
    assert.deepStrictEqual(received[0], msg1);
    assert.deepStrictEqual(received[1], msg2);
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost IPC server handles requests and enforces 0600 socket permissions', async () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-ipc-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');

  const host = new NativeMessagingHost(testSocket);
  await host.ready;

  try {
    const stats = fs.statSync(testSocket);
    assert.strictEqual((stats.mode & 0o777), 0o600);

    // Mock requestFromChrome
    // @ts-expect-error Access private method for testing
    host.requestFromChrome = async (action: string, params: Record<string, unknown>) => {
      return { action, params, echo: 'ipc-works' };
    };

    const client = net.connect(testSocket);
    try {
      const responsePromise = new Promise<string>((resolve) => {
        let buffer = '';
        client.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (buffer.includes('\n')) {
            client.end();
            resolve(buffer);
          }
        });
      });

      client.write(JSON.stringify({ action: 'queryTabs', testParam: 123 }) + '\n');
      const rawRes = await responsePromise;
      const res = JSON.parse(rawRes.trim());

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.result.action, 'queryTabs');
      assert.strictEqual(res.result.echo, 'ipc-works');
    } finally {
      client.destroy();
    }
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost IPC server rejects oversized lines exceeding 10MB', async () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-cap-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');

  const host = new NativeMessagingHost(testSocket);
  await host.ready;

  try {
    const client = net.connect(testSocket);
    try {
      const closedPromise = new Promise<void>((resolve) => {
        client.on('close', () => resolve());
        client.on('error', () => resolve());
      });

      // Write > 10MB of data without newline
      const largeChunk = Buffer.alloc(1024 * 1024, 'a');
      for (let i = 0; i < 11; i++) {
        client.write(largeChunk);
      }

      let timeoutId: NodeJS.Timeout | undefined;
      await Promise.race([
        closedPromise,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Timeout waiting for socket termination')), 4000);
        }),
      ]);
      if (timeoutId) clearTimeout(timeoutId);
    } finally {
      client.destroy();
    }
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
