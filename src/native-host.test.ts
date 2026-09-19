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
import { removeDiscovery, writeDiscovery } from './discovery.js';

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
    host.requestFromChrome = async () => {
      chromeCalls += 1;
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
    assert.strictEqual(chromeCalls, 2, 'quarantined inspection reached Chrome after the close attempt');

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
      const closedPromise = new Promise<void>((resolve) => {
        client.on('close', () => resolve());
        client.on('error', () => resolve());
      });

      // Write > 10MB of data without newline once connected
      const largeChunk = Buffer.alloc(1024 * 1024, 'a');
      client.on('connect', () => {
        for (let i = 0; i < 11; i++) {
          client.write(largeChunk);
        }
      });

      let timeoutId: NodeJS.Timeout | undefined;
      await Promise.race([
        closedPromise,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Timeout waiting for socket termination')), 10000);
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
