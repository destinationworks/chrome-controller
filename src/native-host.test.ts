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
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  getSocketPath,
  ensureSocketDir,
  cleanupStaleSocket,
  NativeMessagingHost,
  pidFilePathForSocket,
  readHostPid,
} from './native-host.js';
import { removeDiscovery, writeDiscovery } from './discovery.js';
import { startScriptedChrome } from '../test/scripted-chrome.ts';

const TEST_API_KEY = 'test-key-0123456789abcdef01234567';

async function ipcRequest(socketPath: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = net.connect(socketPath);
  try {
    const responsePromise = new Promise<string>((resolve, reject) => {
      let buffer = '';
      client.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('\n')) resolve(buffer.slice(0, buffer.indexOf('\n')));
      });
      client.on('error', reject);
    });
    client.write(JSON.stringify(payload) + '\n');
    return JSON.parse(await responsePromise) as Record<string, unknown>;
  } finally {
    client.destroy();
  }
}

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

test('ensureSocketDir rejects a symlinked parent directory', () => {
  if (process.platform === 'win32') return;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'socket-symlink-test-'));
  const target = path.join(tmpBase, 'target');
  const link = path.join(tmpBase, 'link');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link);
  try {
    assert.throws(() => ensureSocketDir(path.join(link, 'test.sock')), /real directory/);
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost rejects an active socket without disrupting its owner', async () => {
  if (process.platform === 'win32') return;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-active-socket-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const first = new NativeMessagingHost(testSocket);
  await first.ready;
  // @ts-expect-error Access private method for active-listener ownership testing
  first.requestFromChrome = async () => ({ owner: 'first' });
  const second = new NativeMessagingHost(testSocket);
  try {
    await assert.rejects(second.ready, /already active/);
    const response = await ipcRequest(testSocket, { id: 1, action: 'queryTabs' });
    assert.deepEqual(response.result, { owner: 'first' });
  } finally {
    second.close();
    first.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost close before ready cancels listener startup', async () => {
  if (process.platform === 'win32') return;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-cancel-startup-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const host = new NativeMessagingHost(testSocket);
  queueMicrotask(() => host.close());
  try {
    await assert.rejects(
      Promise.race([
        host.ready,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('ready remained pending')), 250)),
      ]),
      /startup was cancelled/,
    );
    assert.equal(fs.existsSync(testSocket), false);
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost refuses to replace an unexpected regular file', async () => {
  if (process.platform === 'win32') return;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-file-collision-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  fs.writeFileSync(testSocket, 'do-not-delete');
  const host = new NativeMessagingHost(testSocket);
  try {
    await assert.rejects(host.ready, /Refusing to replace unexpected/);
    assert.equal(fs.readFileSync(testSocket, 'utf8'), 'do-not-delete');
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
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

test('NativeMessagingHost strips reserved sensitive fields from external IPC requests', async () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-sensitive-param-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;

  try {
    // @ts-expect-error Access private method for IPC-boundary testing
    host.requestFromChrome = async (_action: string, params: Record<string, unknown>) => params;
    const response = await ipcRequest(testSocket, {
      action: 'evaluateOnPage',
      tabId: 42,
      expression: 'window.location.href',
      sensitive: true,
      guardValue: 'SyntheticReservedValue_44!',
      guardTtlSeconds: 300,
    });
    assert.equal(response.success, true);
    assert.equal(response.result.sensitive, undefined);
    assert.equal(response.result.guardValue, undefined);
    assert.equal(response.result.guardTtlSeconds, undefined);
    assert.equal(response.result.tabId, 42);
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost guards later DOM, accessibility, encoded, and error output', async () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-secret-guard-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;

  const synthetic = 'SyntheticGuardValue_42!';
  const base64 = Buffer.from(synthetic, 'utf8').toString('base64');
  const hex = Buffer.from(synthetic, 'utf8').toString('hex');
  const reversed = Array.from(synthetic).reverse().join('');
  const unicodeSynthetic = '密碼';
  const unicodeBase64 = Buffer.from(unicodeSynthetic, 'utf8').toString('base64');
  const unicodeHex = Buffer.from(unicodeSynthetic, 'utf8').toString('hex');
  const originalConsoleError = console.error;
  const eventLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => { eventLogs.push(args); };

  try {
    // @ts-expect-error Access private method for integration-boundary testing
    host.requestFromChrome = async (action: string, params: Record<string, unknown>) => {
      if (action === 'preflightSecretTarget') return { tabId: params.targetTabId };
      if (action === 'evaluateOnPage') {
        assert.strictEqual(params.sensitive, true, 'guarded evaluation did not suppress extension logs/events');
        const expression = String(params.expression || '');
        const secret = expression.includes('unicode-fixture')
          ? unicodeSynthetic
          : expression.includes('encoded-fixture') ? 'ab~?' : synthetic;
        // This event occurs after page extraction but before the native host knows
        // the value. It must be dropped rather than logged without a pattern.
        // @ts-expect-error Access private method for interval-leak regression
        host.handleMessageFromChrome({ event: 'debuggerEvent', params: { value: secret } });
        return { result: { value: { secret, guard: { guarded: true, masked: 3, residual: 0 } } } };
      }
      if (action === 'explode') {
        throw new Error([
          synthetic,
          base64,
          base64.replace(/=+$/, ''),
          hex,
          hex.toUpperCase(),
          reversed,
        ].join('|'));
      }
      if (action === 'encoded') {
        return {
          standard: 'YWJ+Pw==',
          standardUnpadded: 'YWJ+Pw',
          urlSafe: 'YWJ-Pw==',
          urlSafeUnpadded: 'YWJ-Pw',
          percentLower: 'ab~%3f',
        };
      }
      if (action === 'unicode') {
        return { raw: unicodeSynthetic, base64: unicodeBase64, hex: unicodeHex, reversed: Array.from(unicodeSynthetic).reverse().join('') };
      }
      return {
        dom: { innerText: `Password: ${synthetic}`, encoded: base64, encodedUnpadded: base64.replace(/=+$/, '') },
        accessibility: { role: 'textbox', name: synthetic, value: hex, upperHex: hex.toUpperCase() },
        reversed,
      };
    };

    const extraction = await ipcRequest(testSocket, {
      action: 'extractSecretGuarded',
      tabId: 42,
      expression: 'primary-fixture',
      ttlSeconds: 300,
    });
    assert.strictEqual(extraction.success, true);
    assert.deepStrictEqual(extraction.result, { value: synthetic, masked: 3 });
    assert.strictEqual(eventLogs.length, 0, 'pre-registration debugger event was logged');

    const guarded = await ipcRequest(testSocket, { action: 'inspectPage' });
    assert.strictEqual(guarded.success, true);
    const guardedText = JSON.stringify(guarded);
    for (const forbidden of [synthetic, base64, hex, hex.toUpperCase(), reversed]) {
      assert.ok(!guardedText.includes(forbidden), `guarded output leaked ${forbidden}`);
    }
    assert.match(guardedText, /SECURE_CLIPBOARD_REDACTED/);

    const encodedExtraction = await ipcRequest(testSocket, {
      action: 'extractSecretGuarded',
      tabId: 42,
      expression: 'encoded-fixture',
      ttlSeconds: 300,
    });
    assert.strictEqual(encodedExtraction.success, true);
    const encoded = await ipcRequest(testSocket, { action: 'encoded' });
    for (const forbidden of ['YWJ+Pw==', 'YWJ+Pw', 'YWJ-Pw==', 'YWJ-Pw', 'ab~%3f']) {
      assert.ok(!JSON.stringify(encoded).includes(forbidden), `encoded output leaked ${forbidden}`);
    }

    const unicodeExtraction = await ipcRequest(testSocket, {
      action: 'extractSecretGuarded',
      tabId: 42,
      expression: 'unicode-fixture',
      ttlSeconds: 300,
    });
    assert.strictEqual(unicodeExtraction.success, true);
    const unicode = await ipcRequest(testSocket, { action: 'unicode' });
    for (const forbidden of [unicodeSynthetic, unicodeBase64, unicodeHex, Array.from(unicodeSynthetic).reverse().join('')]) {
      assert.ok(!JSON.stringify(unicode).includes(forbidden), `unicode-derived output leaked ${forbidden}`);
    }

    const failed = await ipcRequest(testSocket, { action: 'explode' });
    assert.strictEqual(failed.success, false);
    for (const forbidden of [synthetic, base64, base64.replace(/=+$/, ''), hex, hex.toUpperCase(), reversed]) {
      assert.ok(!JSON.stringify(failed).includes(forbidden), `error output leaked ${forbidden}`);
    }
    assert.match(String(failed.error), /SECURE_CLIPBOARD_REDACTED/);

    // @ts-expect-error Access private method to verify post-registration event sanitization
    host.handleMessageFromChrome({ event: 'debuggerEvent', params: { value: `${synthetic}|${base64}|${hex.toUpperCase()}|${reversed}` } });
    const eventLogText = JSON.stringify(eventLogs);
    for (const forbidden of [synthetic, base64, hex.toUpperCase(), reversed]) {
      assert.ok(!eventLogText.includes(forbidden), `native event log leaked ${forbidden}`);
    }
    assert.match(eventLogText, /SECURE_CLIPBOARD_REDACTED/);

    const eventCount = eventLogs.length;
    // @ts-expect-error Zero is a valid-looking but unknown response id; it must not be logged as an event.
    host.handleMessageFromChrome({ id: 0, result: { value: synthetic } });
    assert.strictEqual(eventLogs.length, eventCount, 'zero-id late response was logged as an event');
    // @ts-expect-error Simulate a late response whose timed-out request id is tombstoned
    host.handleMessageFromChrome({ id: 999999, result: { value: synthetic } });
    assert.strictEqual(eventLogs.length, eventCount, 'late response was logged as an event');
  } finally {
    console.error = originalConsoleError;
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost quarantines output after an indeterminate guarded extraction', async () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-secret-quarantine-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  let chromeCalls = 0;
  const originalConsoleError = console.error;
  const eventLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => { eventLogs.push(args); };

  try {
    // @ts-expect-error Access private method for indeterminate-failure testing
    host.requestFromChrome = async (action: string, params: Record<string, unknown>) => {
      chromeCalls += 1;
      if (action === 'preflightSecretTarget') return { tabId: params.targetTabId };
      throw new Error('Synthetic transport timeout with unknown page outcome');
    };
    const extraction = await ipcRequest(testSocket, {
      action: 'extractSecretGuarded',
      tabId: 42,
      expression: 'indeterminate-fixture',
      ttlSeconds: 300,
    });
    assert.strictEqual(extraction.success, false);

    const inspection = await ipcRequest(testSocket, { action: 'inspectPage', tabId: 42 });
    assert.strictEqual(inspection.success, false);
    assert.match(String(inspection.error), /quarantined/);
    assert.strictEqual(chromeCalls, 3, 'quarantined inspection reached Chrome after the close attempt');

    // @ts-expect-error Access private method for quarantine egress regression coverage
    host.handleMessageFromChrome({ event: 'debuggerEvent', params: { value: 'unregistered-secret' } });
    assert.strictEqual(eventLogs.length, 0, 'quarantined unsolicited browser event was logged');
  } finally {
    console.error = originalConsoleError;
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost validates TTL and guard capacity before touching Chrome', async () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-preflight-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  let chromeCalls = 0;

  try {
    // @ts-expect-error Access private method for boundary testing
    host.requestFromChrome = async () => { chromeCalls += 1; return {}; };

    for (const ttlSeconds of [-1, 0, 1.5, '30', true]) {
      const invalidTtl = await ipcRequest(testSocket, {
        action: 'extractSecretGuarded',
        tabId: 42,
        selector: '#secret',
        ttlSeconds,
      });
      assert.strictEqual(invalidTtl.success, false);
      assert.match(String(invalidTtl.error), /TTL/);
    }
    assert.strictEqual(chromeCalls, 0, 'invalid TTL caused a browser request');

    // Re-registering the same raw value must extend one guard, not consume a
    // second capacity slot (derived encodings are sorted ahead of raw text).
    // @ts-expect-error Access private method for deduplication testing
    host.registerSensitiveOutputGuard('duplicate-capacity-fixture', 300);
    // @ts-expect-error Access private method for deduplication testing
    host.registerSensitiveOutputGuard('duplicate-capacity-fixture', 300);
    // @ts-expect-error Access private state for capacity accounting
    assert.equal(host.sensitiveOutputGuards.length, 1);

    for (let i = 1; i < 64; i += 1) {
      // @ts-expect-error Access private method for capacity preflight testing
      host.registerSensitiveOutputGuard(`capacity-${i}`, 300);
    }
    const atCapacity = await ipcRequest(testSocket, {
      action: 'extractSecretGuarded',
      tabId: 42,
      selector: '#secret',
      ttlSeconds: 300,
    });
    assert.strictEqual(atCapacity.success, false);
    assert.match(String(atCapacity.error), /capacity/);
    assert.strictEqual(chromeCalls, 0, 'guard capacity failure caused a browser request');
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost redacts numeric primitives matching a guarded secret', async () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-numeric-guard-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  const originalConsoleError = console.error;
  const eventLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => { eventLogs.push(args); };

  try {
    // @ts-expect-error Access private method for primitive redaction testing
    host.registerSensitiveOutputGuard('123456', 300);
    // @ts-expect-error Access private method for primitive redaction testing
    host.handleMessageFromChrome({ event: 'debuggerEvent', params: { value: 123456 } });
    const output = JSON.stringify(eventLogs);
    assert.ok(!output.includes('123456'));
    assert.match(output, /SECURE_CLIPBOARD_REDACTED/);
  } finally {
    console.error = originalConsoleError;
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost IPC preserves UTF-8 split across socket chunks', async () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-utf8-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  const unicode = '密碼🔐';

  try {
    // @ts-expect-error Access private method for transport testing
    host.requestFromChrome = async (_action: string, params: Record<string, unknown>) => params;
    const client = net.connect(testSocket);
    const responsePromise = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      client.on('data', (chunk) => {
        chunks.push(chunk);
        const combined = Buffer.concat(chunks);
        const newline = combined.indexOf(0x0a);
        if (newline >= 0) resolve(combined.subarray(0, newline).toString('utf8'));
      });
      client.on('error', reject);
    });
    await new Promise<void>((resolve) => client.once('connect', resolve));
    const frame = Buffer.from(JSON.stringify({ action: 'echo', unicode }) + '\n', 'utf8');
    const firstMultibyte = frame.indexOf(Buffer.from('密', 'utf8'));
    client.write(frame.subarray(0, firstMultibyte + 1));
    client.write(frame.subarray(firstMultibyte + 1));
    const response = JSON.parse(await responsePromise) as { result: { unicode: string } };
    assert.equal(response.result.unicode, unicode);
    client.destroy();
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost rejects unbounded or non-numeric request timeouts', async () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-timeout-validation-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  try {
    await assert.rejects(
      host.requestFromChrome('queryTabs', { timeoutMs: '15000' }),
      /timeout must be an integer/i,
    );
    await assert.rejects(
      host.requestFromChrome('queryTabs', { timeoutMs: 120001 }),
      /timeout must be an integer/i,
    );
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('the host waits requestTimeoutMs, the key the relay honours, ahead of timeoutMs', async (t) => {
  if (process.platform === 'win32') return;
  const chrome = await startScriptedChrome('nmh-request-timeout-');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const answered = chrome.host.requestFromChrome('queryTabs', { timeoutMs: 1000, requestTimeoutMs: 5000 });
    const first = await chrome.nextRequest();
    t.mock.timers.tick(4999);
    chrome.answer(first.id, 'in time');
    assert.equal(await answered, 'in time');

    const silent = chrome.host.requestFromChrome('queryTabs', { timeoutMs: 1000, requestTimeoutMs: 5000 });
    await chrome.nextRequest();
    t.mock.timers.tick(5000);
    await assert.rejects(silent, /Native Messaging request timed out after 5000ms/);

    await assert.rejects(
      chrome.host.requestFromChrome('queryTabs', { requestTimeoutMs: 120001 }),
      /timeout must be an integer/i,
    );
  } finally {
    chrome.close();
  }
});

test('the host refuses at once an action that cannot finish within its cap, forwarding nothing', async () => {
  if (process.platform === 'win32') return;
  const chrome = await startScriptedChrome('nmh-impossible-');
  const forwarded: unknown[] = [];
  chrome.host.sendToChrome = (payload) => { forwarded.push(payload); };
  try {
    await assert.rejects(
      chrome.host.requestFromChrome('getConsoleLogs', { tabId: 1, timeoutMs: 200000 }),
      /getConsoleLogs needs at least 200000ms of Chrome time, beyond the 120000ms limit/,
    );
    assert.deepEqual(forwarded, [], 'Chrome never starts work the host would abandon');
  } finally {
    chrome.close();
  }
});

test('the host never uses a console-collection window as its wait for Chrome', async (t) => {
  if (process.platform === 'win32') return;
  const chrome = await startScriptedChrome('nmh-console-window-');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // The extension answers getConsoleLogs only after collecting for the whole
    // window, so a wait equal to the window always loses the race.
    const logs = chrome.host.requestFromChrome('getConsoleLogs', { tabId: 1, timeoutMs: 2000 });
    const request = await chrome.nextRequest();
    assert.equal(request.timeoutMs, 2000, 'the window still reaches the extension');
    t.mock.timers.tick(2007); // measured on a live Chrome
    chrome.answer(request.id, { logs: [], count: 0 });
    assert.deepEqual(await logs, { logs: [], count: 0 });
  } finally {
    chrome.close();
  }
});

test('NativeMessagingHost guarded injection registers output protection before returning', async () => {
  if (process.platform === 'win32') return;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-injection-test-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  const synthetic = 'SyntheticInjectionValue_73!';

  try {
    // @ts-expect-error Access private method for integration-boundary testing
    host.requestFromChrome = async (action: string, params: Record<string, unknown>) => {
      if (action === 'preflightSecretTarget') return { tabId: params.targetTabId };
      assert.equal(action, 'evaluateOnPage');
      assert.equal(params.sensitive, true);
      assert.equal(params.guardValue, synthetic);
      return { result: { value: { injected: true } } };
    };
    const injection = await ipcRequest(testSocket, {
      action: 'injectSecretGuarded',
      tabId: 42,
      selector: '#password',
      value: synthetic,
      ttlSeconds: 300,
    });
    assert.deepEqual(injection, { success: true, result: { injected: true } });

    const inspected = await ipcRequest(testSocket, { action: 'inspectPage' });
    assert.ok(!JSON.stringify(inspected).includes(synthetic));
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
      const terminated = new Promise<void>((resolve) => {
        client.on('close', () => resolve());
        client.on('error', () => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
      });

      // Feed 1MB at a time, respecting backpressure, and stop the moment the
      // host tears the connection down. Queueing all 11MB up front left the
      // client waiting on an unflushable write buffer for an unbounded time,
      // which made this test flaky rather than testing the host's cap.
      const chunk = Buffer.alloc(1024 * 1024, 'a');
      let destroyed = false;
      client.once('close', () => { destroyed = true; });
      client.once('error', () => { destroyed = true; });

      for (let i = 0; i < 11 && !destroyed; i++) {
        if (!client.write(chunk)) {
          await Promise.race([
            new Promise<void>((resolve) => client.once('drain', () => resolve())),
            terminated,
          ]);
        }
      }

      let timeoutId: NodeJS.Timeout | undefined;
      await Promise.race([
        terminated,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Timeout waiting for socket termination')), 10000);
        }),
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      assert.ok(destroyed, 'host must destroy the connection for an over-cap line');
    } finally {
      client.destroy();
    }
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('NativeMessagingHost pairs relay credentials only through the native channel', async () => {
  if (process.platform === 'win32') return;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-relay-pairing-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const instance = `native-pairing-${Date.now()}`;
  const previousInstance = process.env.CHROME_CONTROLLER_INSTANCE;
  process.env.CHROME_CONTROLLER_INSTANCE = instance;
  writeDiscovery(instance, {
    httpPort: 43111,
    wsPort: 43112,
    apiKey: TEST_API_KEY,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  const sent: Record<string, unknown>[] = [];
  host.sendToChrome = (payload) => { sent.push(payload); };

  try {
    // @ts-expect-error Access private method for native-channel contract testing
    host.handleMessageFromChrome({ action: 'getRelayConfig' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, 'relayConfig');
    assert.deepEqual(sent[0].relay, {
      instance,
      wsPort: 43112,
      apiKey: TEST_API_KEY,
      pid: process.pid,
      startedAt: readDiscoveryStartedAt(instance),
    });
  } finally {
    host.close();
    removeDiscovery(instance);
    fs.rmSync(tmpBase, { recursive: true, force: true });
    if (previousInstance === undefined) delete process.env.CHROME_CONTROLLER_INSTANCE;
    else process.env.CHROME_CONTROLLER_INSTANCE = previousInstance;
  }
});

test('NativeMessagingHost reports relay pairing unavailable for missing or insecure discovery', async () => {
  if (process.platform === 'win32') return;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-relay-unavailable-'));
  const testSocket = path.join(tmpBase, 'test.sock');
  const instance = `native-unavailable-${Date.now()}`;
  const previousInstance = process.env.CHROME_CONTROLLER_INSTANCE;
  process.env.CHROME_CONTROLLER_INSTANCE = instance;
  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  const sent: Record<string, unknown>[] = [];
  host.sendToChrome = (payload) => { sent.push(payload); };

  try {
    // @ts-expect-error Access private method for native-channel contract testing
    host.handleMessageFromChrome({ action: 'getRelayConfig' });
    assert.equal(sent.at(-1)?.event, 'relayConfigUnavailable');

    writeDiscovery(instance, {
      httpPort: 43111,
      wsPort: 43112,
      apiKey: TEST_API_KEY,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const discoveryFile = path.join(os.homedir(), '.chrome-controller', `${instance}.json`);
    fs.chmodSync(discoveryFile, 0o644);
    // @ts-expect-error Access private method for insecure-discovery rejection testing
    host.handleMessageFromChrome({ action: 'getRelayConfig' });
    assert.equal(sent.at(-1)?.event, 'relayConfigUnavailable');
  } finally {
    host.close();
    removeDiscovery(instance);
    const discoveryFile = path.join(os.homedir(), '.chrome-controller', `${instance}.json`);
    try { fs.chmodSync(discoveryFile, 0o600); } catch { /* already absent */ }
    removeDiscovery(instance);
    fs.rmSync(tmpBase, { recursive: true, force: true });
    if (previousInstance === undefined) delete process.env.CHROME_CONTROLLER_INSTANCE;
    else process.env.CHROME_CONTROLLER_INSTANCE = previousInstance;
  }
});

function readDiscoveryStartedAt(instance: string): string {
  const raw = fs.readFileSync(path.join(os.homedir(), '.chrome-controller', `${instance}.json`), 'utf8');
  return (JSON.parse(raw) as { startedAt: string }).startedAt;
}

test('hostPing is answered locally and never forwarded to Chrome', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-hostping-test-'));
  const testSocket = path.join(tmpBase, 'run.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;

  // Spy on the one path that reaches the browser. Stubbing process.stdout is
  // unreliable here: the test runner writes its own Buffer chunks to stdout.
  const forwarded: unknown[] = [];
  const originalSend = host.sendToChrome.bind(host);
  host.sendToChrome = (payload) => { forwarded.push(payload); originalSend(payload); };

  try {
    const response = await ipcRequest(testSocket, { id: 7, action: 'hostPing' });
    assert.strictEqual(response.success, true);
    const result = response.result as Record<string, unknown>;
    assert.strictEqual(result.pong, true);
    assert.strictEqual(result.pid, process.pid);
    assert.strictEqual(result.pendingRequests, 0);
    // The wedge is only detectable if the probe never depends on the browser.
    assert.deepStrictEqual(forwarded, [], 'hostPing must not forward anything to Chrome');
  } finally {
    host.sendToChrome = originalSend;
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('hostPing still answers while browser output is quarantined', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-hostping-quarantine-test-'));
  const testSocket = path.join(tmpBase, 'run.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  (host as unknown as { browserOutputQuarantined: boolean }).browserOutputQuarantined = true;

  try {
    const ping = await ipcRequest(testSocket, { id: 1, action: 'hostPing' });
    assert.strictEqual(ping.success, true);
    assert.strictEqual((ping.result as Record<string, unknown>).browserOutputQuarantined, true);

    // A quarantined host must still refuse real browser work.
    const blocked = await ipcRequest(testSocket, { id: 2, action: 'queryTabs' });
    assert.strictEqual(blocked.success, false);
    assert.match(String(blocked.error), /quarantined/);
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('a PID file write failure rolls back the listener and the socket', async () => {
  if (process.platform === 'win32') return;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-pid-rollback-'));
  const testSocket = path.join(tmpBase, 'run.sock');

  // A directory at the PID path makes writeFileSync fail with EISDIR after the
  // listener is already bound -- the rollback branch, which nothing else hits.
  fs.mkdirSync(pidFilePathForSocket(testSocket));

  const host = new NativeMessagingHost(testSocket);
  await assert.rejects(host.ready, /PID file write failed/);
  assert.strictEqual(fs.existsSync(testSocket), false, 'rollback must remove the bound socket');

  host.close();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

test('a second host must not clobber the live host PID file', async () => {
  if (process.platform === 'win32') return;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-pid-conflict-test-'));
  const testSocket = path.join(tmpBase, 'run.sock');

  // Spawn the incumbent as a separate process so the PIDs genuinely differ;
  // an in-process second host would write the identical value and prove nothing.
  // Load the host from source via the same tsx loader this test runs under.
  // Requiring dist/ would make the test depend on a prior build, which CI does
  // not have: it runs `npm test` before `npm run build`.
  const hostModule = pathToFileURL(path.resolve('src/native-host.ts')).href;
  const script = path.join(tmpBase, 'incumbent.mjs');
  fs.writeFileSync(script, `
    import { NativeMessagingHost } from ${JSON.stringify(hostModule)};
    const host = new NativeMessagingHost(${JSON.stringify(testSocket)});
    host.ready.then(() => console.log('up')).catch((e) => { console.error(e.message); process.exit(1); });
    setInterval(() => {}, 1000);
  `);
  const incumbent = spawn(process.execPath, ['--import', 'tsx', script]);
  try {
    await new Promise<void>((resolve, reject) => {
      incumbent.stdout.on('data', (d: Buffer) => { if (d.toString().includes('up')) resolve(); });
      // The host logs "IPC listening on ..." to stderr on success, so only a
      // non-zero exit counts as failure here.
      incumbent.once('exit', (code) => reject(new Error(`incumbent exited early with code ${code}`)));
      incumbent.once('error', reject);
    });
    assert.strictEqual(readHostPid(testSocket), incumbent.pid);

    const loser = new NativeMessagingHost(testSocket);
    await assert.rejects(loser.ready, /already active/);
    loser.close();

    assert.strictEqual(readHostPid(testSocket), incumbent.pid, 'the live host PID must survive');
    assert.notStrictEqual(incumbent.pid, process.pid);
  } finally {
    incumbent.kill('SIGKILL');
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('IPC flood must not stall concurrent requests (event-loop wedge regression)', async () => {
  if (process.platform === 'win32') return;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-flood-latency-'));
  const testSocket = path.join(tmpBase, 'run.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;

  const flooder = net.connect(testSocket);
  let floodDone = false;
  const latencies: number[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      flooder.once('connect', () => resolve());
      flooder.once('error', reject);
    });
    flooder.on('error', () => { floodDone = true; });
    flooder.on('close', () => { floodDone = true; });

    // Feed just under the 10MB cap with no newline, in kernel-sized pieces.
    // Concatenating per chunk copied ~6.4GB here and blocked the loop, so a
    // concurrent client saw multi-second latency on a request that touches
    // nothing. hostPing is answered locally, so any delay is pure loop stall.
    const piece = Buffer.alloc(8192, 'a');
    const pieces = Math.floor((9 * 1024 * 1024) / piece.length);

    const floodStartedAt = Date.now();
    let floodElapsed = 0;
    const flood = (async () => {
      for (let i = 0; i < pieces && !floodDone; i++) {
        if (!flooder.write(piece)) {
          await new Promise<void>((resolve) => flooder.once('drain', () => resolve()));
        }
      }
      floodElapsed = Date.now() - floodStartedAt;
      floodDone = true;
    })();

    while (!floodDone) {
      const startedAt = Date.now();
      const response = await ipcRequest(testSocket, { id: 1, action: 'hostPing' });
      latencies.push(Date.now() - startedAt);
      assert.strictEqual(response.success, true);
    }
    await flood;

    assert.ok(latencies.length > 0, 'expected at least one probe during the flood');
    // Per-request latency alone does not catch this: each individual copy is
    // only milliseconds. The regression is cumulative, so assert the whole
    // flood clears promptly. Concatenating per chunk copies ~6.4GB here and
    // takes 7-8s; the chunk-list reader takes well under a second.
    assert.ok(
      floodElapsed < 3000,
      `absorbing ${pieces * piece.length} bytes took ${floodElapsed}ms; the read path is copying the accumulated buffer per chunk`,
    );
    const worst = Math.max(...latencies);
    assert.ok(worst < 1000, `hostPing stalled ${worst}ms during an IPC flood; the read path is blocking the event loop`);
  } finally {
    flooder.destroy();
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('IPC reader accepts a line exactly at the cap and rejects one byte more', async () => {
  if (process.platform === 'win32') return;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-cap-boundary-'));
  const testSocket = path.join(tmpBase, 'run.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  const MAX = 10 * 1024 * 1024;

  try {
    // A line exactly at the cap must still be parsed, not dropped. It is
    // invalid JSON, so the host answers with its parse error rather than
    // destroying the connection.
    const filler = 'x'.repeat(MAX - 2);
    const atCap = Buffer.from(`"${filler}"`, 'utf8');
    assert.strictEqual(atCap.length, MAX);

    const client = net.connect(testSocket);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
      });
      const replied = new Promise<string>((resolve) => {
        let buf = '';
        client.on('data', (d) => { buf += d.toString('utf8'); if (buf.includes('\n')) resolve(buf.slice(0, buf.indexOf('\n'))); });
      });
      client.write(atCap);
      client.write('\n');
      const response = JSON.parse(await replied) as Record<string, unknown>;
      assert.strictEqual(response.success, false, 'an at-cap line must reach the parser');
    } finally {
      client.destroy();
    }

    // One byte over the cap must destroy the connection instead.
    const over = net.connect(testSocket);
    try {
      await new Promise<void>((resolve, reject) => {
        over.once('connect', () => resolve());
        over.once('error', reject);
      });
      const terminated = new Promise<void>((resolve) => {
        over.once('close', () => resolve());
        over.once('error', () => resolve());
      });
      const piece = Buffer.alloc(64 * 1024, 'a');
      let sent = 0;
      let dead = false;
      over.once('close', () => { dead = true; });
      over.once('error', () => { dead = true; });
      while (sent <= MAX && !dead) {
        if (!over.write(piece)) {
          await Promise.race([new Promise<void>((r) => over.once('drain', () => r())), terminated]);
        }
        sent += piece.length;
      }
      await terminated;
      assert.ok(dead, 'an over-cap line must destroy the connection');
    } finally {
      over.destroy();
    }
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('hostPing answers during guarded extraction without disturbing it', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-hostping-sensitive-'));
  const testSocket = path.join(tmpBase, 'run.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  const internals = host as unknown as {
    sensitiveExtractionInProgress: boolean;
    pendingRequests: Map<number, unknown>;
  };

  try {
    internals.sensitiveExtractionInProgress = true;

    const ping = await ipcRequest(testSocket, { id: 1, action: 'hostPing' });
    assert.strictEqual(ping.success, true);
    assert.strictEqual((ping.result as Record<string, unknown>).sensitiveExtractionInProgress, true);

    // Real browser work must still be locked out while a secret is in flight.
    const blocked = await ipcRequest(testSocket, { id: 2, action: 'queryTabs' });
    assert.strictEqual(blocked.success, false);
    assert.match(String(blocked.error), /locked during guarded extraction/);

    // extractSecretGuarded refuses to start while pendingRequests is non-empty,
    // so a polling watchdog must never leave entries behind.
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => ipcRequest(testSocket, { id: i, action: 'hostPing' })),
    );
    assert.strictEqual(internals.pendingRequests.size, 0, 'hostPing must not touch pendingRequests');
  } finally {
    internals.sensitiveExtractionInProgress = false;
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('livenessSnapshot exposes only non-sensitive scalar fields', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-snapshot-shape-'));
  const testSocket = path.join(tmpBase, 'run.sock');
  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  try {
    // The snapshot is written to the client without sanitizeSensitiveOutput,
    // so its shape is pinned: a future field cannot slip past the sanitizer.
    const snapshot = host.livenessSnapshot();
    assert.deepStrictEqual(Object.keys(snapshot).sort(), [
      'browserOutputQuarantined',
      'chromeConnected',
      'lastChromeMessageAt',
      'pendingRequests',
      'pid',
      'pong',
      'sensitiveExtractionInProgress',
      'startedAt',
      'uptimeMs',
    ]);
    for (const [key, value] of Object.entries(snapshot)) {
      assert.ok(
        value === null || ['boolean', 'number'].includes(typeof value),
        `${key} must be a scalar, got ${typeof value}`,
      );
    }
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('PID file is private even when a world-readable file is already there', async () => {
  if (process.platform === 'win32') return;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-pid-mode-'));
  const testSocket = path.join(tmpBase, 'run.sock');
  const pidPath = pidFilePathForSocket(testSocket);
  // writeFileSync's mode is ignored for an existing file, so a leftover from a
  // previous umask would silently stay world-readable.
  fs.writeFileSync(pidPath, '1\n', { mode: 0o644 });
  fs.chmodSync(pidPath, 0o644);

  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  try {
    assert.strictEqual(fs.statSync(pidPath).mode & 0o777, 0o600);
    assert.strictEqual(readHostPid(testSocket), process.pid);
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('PID file write does not follow a symlink planted at its path', async () => {
  if (process.platform === 'win32') return;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-pid-symlink-'));
  const testSocket = path.join(tmpBase, 'run.sock');
  const target = path.join(tmpBase, 'victim.txt');
  fs.writeFileSync(target, 'untouched\n');
  fs.symlinkSync(target, pidFilePathForSocket(testSocket));

  const host = new NativeMessagingHost(testSocket);
  await host.ready;
  try {
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'untouched\n', 'symlink target must not be written through');
    assert.strictEqual(fs.lstatSync(pidFilePathForSocket(testSocket)).isSymbolicLink(), false);
    assert.strictEqual(readHostPid(testSocket), process.pid);
  } finally {
    host.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

// A wrong-profile tab must fail admission before any page operation or new guard.
test('guarded target admission failure preserves unrelated guards without quarantining', async () => {
  if (process.platform === 'win32') return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-target-admission-'));
  const socket = path.join(directory, 'test.sock');
  const host = new NativeMessagingHost(socket);
  await host.ready;
  const synthetic = 'ExistingUnrelatedGuard_42!';
  // @ts-expect-error Access private state to establish an unrelated retained guard.
  host.registerSensitiveOutputGuard(synthetic, 300);
  try {
    for (const action of ['extractSecretGuarded', 'injectSecretGuarded']) {
      for (const outcome of ['missing', 'mismatch', 'malformed']) {
        const calls: string[] = [];
        // @ts-expect-error Replace only the Chrome transport.
        host.requestFromChrome = async (command: string, params: Record<string, unknown>) => {
          calls.push(command);
          if (command === 'preflightSecretTarget') {
            assert.deepEqual(params, { targetTabId: 42, sensitive: true });
            if (outcome === 'mismatch') return { tabId: 99 };
            if (outcome === 'malformed') return null;
            throw new Error(synthetic);
          }
          if (command === 'inspectPage') return { text: synthetic };
          throw new Error('Unexpected page action');
        };
        const result = await ipcRequest(socket, { action, tabId: 42, selector: '#secret', value: 'NewSyntheticValue!', ttlSeconds: 300 });
        assert.equal(result.success, false);
        assert.match(String(result.error), /target admission/);
        assert.ok(!JSON.stringify(result).includes(synthetic));
        assert.deepEqual(calls, ['preflightSecretTarget']);
        const health = await ipcRequest(socket, { action: 'hostPing' });
        assert.equal((health.result as Record<string, unknown>).browserOutputQuarantined, false);
        const inspected = await ipcRequest(socket, { action: 'inspectPage' });
        assert.ok(!JSON.stringify(inspected).includes(synthetic));
        assert.match(JSON.stringify(inspected), /SECURE_CLIPBOARD_REDACTED/);
        // @ts-expect-error Admission must not create or remove guards.
        assert.equal(host.sensitiveOutputGuards.length, 1);
      }
    }
  } finally { host.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});


test('target admission holds serialization and preserves quarantine after a later ambiguous failure', async () => {
  if (process.platform === 'win32') return;
  for (const action of ['extractSecretGuarded', 'injectSecretGuarded']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nmh-target-race-'));
    const socket = path.join(directory, 'test.sock');
    const host = new NativeMessagingHost(socket);
    await host.ready;
    const calls: string[] = [];
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const enteredAdmission = new Promise<void>((resolve) => { entered = resolve; });
    try {
      // @ts-expect-error Replace only the Chrome transport, retaining real IPC concurrency.
      host.requestFromChrome = async (command: string) => {
        calls.push(command);
        if (command === 'preflightSecretTarget') {
          entered();
          return new Promise((resolve) => { release = resolve; });
        }
        throw new Error('Synthetic target disappeared after admission');
      };
      const pending = ipcRequest(socket, { action, tabId: 42, selector: '#secret', value: 'SyntheticInjectionValue!', ttlSeconds: 300 });
      await enteredAdmission;
      const blocked = await ipcRequest(socket, { action: 'queryTabs' });
      assert.equal(blocked.success, false);
      assert.match(String(blocked.error), /locked/);
      assert.deepEqual(calls, ['preflightSecretTarget']);
      release({ tabId: 42 });
      const failed = await pending;
      assert.equal(failed.success, false);
      assert.match(String(failed.error), /quarantined/);
      assert.deepEqual(calls, ['preflightSecretTarget', 'evaluateOnPage', 'removeTab']);
      const health = await ipcRequest(socket, { action: 'hostPing' });
      assert.equal((health.result as Record<string, unknown>).browserOutputQuarantined, true);
      assert.equal((health.result as Record<string, unknown>).sensitiveExtractionInProgress, false);
    } finally { host.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  }
});
