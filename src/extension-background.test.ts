import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import chromeControllerPiExtension from './index.ts';

const TEST_API_KEY = 'test-key-0123456789abcdef01234567';
const backgroundPath = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  'Chrome Extension',
  'background.js',
);
const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

type Listener = (...args: any[]) => unknown;

function eventHook() {
  const listeners: Listener[] = [];
  return {
    addListener(listener: Listener) { listeners.push(listener); },
    removeListener(listener: Listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    async emit(...args: unknown[]) {
      await Promise.all(listeners.map((listener) => listener(...args)));
    },
  };
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function createWorker(
  sharedStorage: Map<string, unknown>,
  options: {
    debuggerSendCommand?: () => Promise<unknown>;
    now?: () => number;
    storageReadsFailing?: boolean;
  } = {},
) {
  const nativeMessages: Record<string, unknown>[] = [];
  const nativeOnMessage = eventHook();
  const nativeOnDisconnect = eventHook();
  const debuggerOnEvent = eventHook();
  const tabRemoved = eventHook();
  const alarmEvent = eventHook();
  const alarmState = new Map<string, Record<string, unknown>>();
  let queryTabsCalls = 0;
  let removeTabCalls = 0;
  let debuggerSendCalls = 0;
  let storageWritesFailing = false;

  const nativePort = {
    onMessage: nativeOnMessage,
    onDisconnect: nativeOnDisconnect,
    postMessage(message: Record<string, unknown>) { nativeMessages.push(clone(message)); },
  };

  class WebSocketMock {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static readonly instances: WebSocketMock[] = [];
    readonly url: string;
    readyState = WebSocketMock.CONNECTING;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => Promise<void> | void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;

    constructor(url: string) {
      this.url = url;
      WebSocketMock.instances.push(this);
    }

    open() {
      this.readyState = WebSocketMock.OPEN;
      this.onopen?.();
    }

    send(message: string) { this.sent.push(message); }

    close() {
      this.readyState = WebSocketMock.CLOSED;
      this.onclose?.();
    }
  }

  const chrome = {
    runtime: {
      id: 'a'.repeat(32),
      lastError: undefined,
      onMessage: eventHook(),
      connectNative: () => nativePort,
    },
    storage: {
      session: {
        async get(key: string) {
          if (options.storageReadsFailing) throw new Error('synthetic session storage read failure');
          return sharedStorage.has(key) ? { [key]: clone(sharedStorage.get(key)) } : {};
        },
        async set(values: Record<string, unknown>) {
          if (storageWritesFailing) throw new Error('synthetic session storage failure');
          for (const [key, value] of Object.entries(values)) sharedStorage.set(key, clone(value));
        },
        async remove(key: string) {
          if (storageWritesFailing) throw new Error('synthetic session storage failure');
          sharedStorage.delete(key);
        },
      },
    },
    alarms: {
      onAlarm: alarmEvent,
      async create(name: string, info: Record<string, unknown>) { alarmState.set(name, clone(info)); },
      async clear(name: string) { return alarmState.delete(name); },
    },
    tabs: {
      onRemoved: tabRemoved,
      async query() { queryTabsCalls += 1; return []; },
      async get(tabId: number) { return { id: tabId, windowId: 1, title: '', url: '', active: true }; },
      async sendMessage() { return {}; },
      async group() { return 1; },
      async remove() { removeTabCalls += 1; },
      async update() { return {}; },
      async create() { return {}; },
    },
    tabGroups: {
      onRemoved: eventHook(),
      async query() { return []; },
      async get() { throw new Error('missing group'); },
      async update() { return {}; },
    },
    debugger: {
      onEvent: debuggerOnEvent,
      async attach() {},
      async detach() {},
      async sendCommand() {
        debuggerSendCalls += 1;
        return options.debuggerSendCommand ? options.debuggerSendCommand() : {};
      },
    },
  };

  const HostDate = Date;
  class WorkerDate extends HostDate {
    static override now() { return options.now ? options.now() : HostDate.now(); }
  }
  const context = vm.createContext({
    chrome,
    Date: WorkerDate,
    WebSocket: WebSocketMock,
    TextEncoder,
    URL,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    structuredClone,
  });
  vm.runInContext(backgroundSource, context, { filename: backgroundPath });

  return {
    alarmEvent,
    alarmState,
    context,
    debuggerOnEvent,
    debuggerSendCalls: () => debuggerSendCalls,
    nativeMessages,
    nativeOnDisconnect,
    nativeOnMessage,
    nativePort,
    queryTabsCalls: () => queryTabsCalls,
    removeTabCalls: () => removeTabCalls,
    setStorageWritesFailing(value: boolean) { storageWritesFailing = value; },
    sockets: WebSocketMock.instances,
  };
}

async function flushWorkerTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('actual extension worker restores guards across restart and enforces them over native and relay paths', async () => {
  const storage = new Map<string, unknown>();
  const first = createWorker(storage);
  await flushWorkerTasks();
  assert.deepEqual(first.nativeMessages[0], { action: 'getRelayConfig' });

  await first.nativeOnMessage.emit({
    event: 'relayConfig',
    relay: {
      instance: 'default',
      wsPort: 43112,
      apiKey: TEST_API_KEY,
      pid: 1234,
      startedAt: new Date().toISOString(),
    },
  });
  await first.nativeOnMessage.emit({
    id: 1,
    action: 'syntheticSensitiveFailure',
    tabId: 42,
    sensitive: true,
    guardValue: 'synthetic-secret',
    guardTtlSeconds: 300,
  });
  assert.match(String(first.nativeMessages.find((message) => message.id === 1)?.error), /details suppressed/);

  const restarted = createWorker(storage);
  await flushWorkerTasks();
  await restarted.nativeOnMessage.emit({ id: 2, action: 'queryTabs' });
  const nativeBlocked = restarted.nativeMessages.find((message) => message.id === 2);
  assert.match(String(nativeBlocked?.error), /protected secret tab/);
  assert.equal(restarted.queryTabsCalls(), 0);

  await restarted.nativeOnDisconnect.emit();
  await flushWorkerTasks();
  assert.equal(restarted.sockets.length, 1);
  const socket = restarted.sockets[0];
  const relayUrl = new URL(socket.url);
  assert.equal(relayUrl.hostname, '127.0.0.1');
  assert.equal(relayUrl.port, '43112');
  assert.equal(relayUrl.searchParams.get('key'), TEST_API_KEY);
  socket.open();

  await socket.onmessage?.({ data: JSON.stringify({ id: 3, action: 'queryTabs' }) });
  const relayBlocked = socket.sent.map((message) => JSON.parse(message)).find((message) => message.id === 3);
  assert.match(String(relayBlocked?.error), /protected secret tab/);
  assert.equal(restarted.queryTabsCalls(), 0);

  const sentBeforeEvent = socket.sent.length;
  await restarted.debuggerOnEvent.emit({ tabId: 42 }, 'Runtime.consoleAPICalled', { value: 'synthetic-secret' });
  assert.equal(socket.sent.length, sentBeforeEvent);

  await restarted.alarmEvent.emit({ name: 'protected-tab:42' });
  await socket.onmessage?.({ data: JSON.stringify({ id: 4, action: 'queryTabs' }) });
  const stillBlocked = socket.sent.map((message) => JSON.parse(message)).find((message) => message.id === 4);
  assert.match(String(stillBlocked?.error), /protected secret tab/);
  assert.equal(restarted.queryTabsCalls(), 0);

  const guardStorage = storage.get('chromeControllerProtectedTabGuards') as Record<string, number>;
  guardStorage['42'] = Date.now() - 1;
  storage.set('chromeControllerProtectedTabGuards', guardStorage);
  const expired = createWorker(storage);
  await flushWorkerTasks();
  await expired.nativeOnMessage.emit({ id: 5, action: 'queryTabs' });
  assert.deepEqual(expired.nativeMessages.find((message) => message.id === 5)?.result, []);
  assert.equal(expired.queryTabsCalls(), 1);
});

test('guard is durable before an in-flight sensitive page action can outlive its worker', async () => {
  const storage = new Map<string, unknown>();
  const command = Promise.withResolvers<unknown>();
  const first = createWorker(storage, { debuggerSendCommand: () => command.promise });
  await flushWorkerTasks();

  const inFlight = first.nativeOnMessage.emit({
    id: 10,
    action: 'evaluateOnPage',
    tabId: 77,
    expression: 'document.body.textContent',
    returnByValue: true,
    sensitive: true,
    guardTtlSeconds: 300,
  });
  await flushWorkerTasks();
  assert.equal(first.debuggerSendCalls(), 1);

  const restarted = createWorker(storage);
  await flushWorkerTasks();
  await restarted.nativeOnMessage.emit({ id: 11, action: 'queryTabs' });
  assert.match(
    String(restarted.nativeMessages.find((message) => message.id === 11)?.error),
    /protected secret tab/,
  );
  assert.equal(restarted.queryTabsCalls(), 0);

  command.resolve({ result: { value: 'synthetic-secret' } });
  await inFlight;
});

test('short post-completion TTL cannot expire while a sensitive action is still in flight', async () => {
  const storage = new Map<string, unknown>();
  const command = Promise.withResolvers<unknown>();
  let now = 1_000_000;
  const clock = () => now;
  const first = createWorker(storage, { debuggerSendCommand: () => command.promise, now: clock });
  await flushWorkerTasks();

  const inFlight = first.nativeOnMessage.emit({
    id: 15,
    action: 'evaluateOnPage',
    tabId: 78,
    expression: 'document.body.textContent',
    sensitive: true,
    guardTtlSeconds: 1,
  });
  await flushWorkerTasks();
  now += 1_100;

  const restarted = createWorker(storage, { now: clock });
  await flushWorkerTasks();
  await restarted.nativeOnMessage.emit({ id: 16, action: 'queryTabs' });
  assert.match(
    String(restarted.nativeMessages.find((message) => message.id === 16)?.error),
    /protected secret tab/,
  );
  assert.equal(restarted.queryTabsCalls(), 0);

  command.resolve({ result: { value: 'synthetic-secret' } });
  await inFlight;
  const persisted = storage.get('chromeControllerProtectedTabGuards') as Record<string, number>;
  assert.equal(persisted['78'], now + 1_000);
});

test('recovery close remains available while another sensitive action is in flight', async () => {
  const storage = new Map<string, unknown>();
  const command = Promise.withResolvers<unknown>();
  const worker = createWorker(storage, { debuggerSendCommand: () => command.promise });
  await flushWorkerTasks();
  const inFlight = worker.nativeOnMessage.emit({
    id: 17,
    action: 'evaluateOnPage',
    tabId: 79,
    expression: 'document.body.textContent',
    sensitive: true,
    guardTtlSeconds: 300,
  });
  await flushWorkerTasks();

  await worker.nativeOnMessage.emit({
    id: 18,
    action: 'removeTab',
    tabId: 79,
    sensitive: true,
    reason: 'guardedExtractionFailure',
  });
  assert.equal(worker.removeTabCalls(), 1);
  assert.deepEqual(worker.nativeMessages.find((message) => message.id === 18)?.result, { success: true });

  command.resolve({ result: { value: 'synthetic-secret' } });
  await inFlight;
});

test('renewal never shortens a guard and a stale alarm cannot clear it', async () => {
  const storage = new Map<string, unknown>();
  const worker = createWorker(storage);
  await flushWorkerTasks();

  await worker.nativeOnMessage.emit({
    id: 20,
    action: 'syntheticSensitiveFailure',
    tabId: 42,
    sensitive: true,
    guardTtlSeconds: 300,
  });
  const firstExpiry = Number(worker.alarmState.get('protected-tab:42')?.when);

  await worker.nativeOnMessage.emit({
    id: 21,
    action: 'syntheticSensitiveFailure',
    tabId: 42,
    sensitive: true,
    guardTtlSeconds: 1,
  });
  const renewedExpiry = Number(worker.alarmState.get('protected-tab:42')?.when);
  assert.equal(renewedExpiry, firstExpiry);

  await worker.alarmEvent.emit({ name: 'protected-tab:42' });
  assert.equal(Number(worker.alarmState.get('protected-tab:42')?.when), firstExpiry);
  await worker.nativeOnMessage.emit({ id: 22, action: 'queryTabs' });
  assert.match(String(worker.nativeMessages.find((message) => message.id === 22)?.error), /protected secret tab/);
  assert.equal(worker.queryTabsCalls(), 0);
});

test('a sensitive action fails closed before page access when guard persistence fails', async () => {
  const storage = new Map<string, unknown>();
  const worker = createWorker(storage);
  await flushWorkerTasks();
  worker.setStorageWritesFailing(true);

  await worker.nativeOnMessage.emit({
    id: 30,
    action: 'evaluateOnPage',
    tabId: 42,
    expression: 'document.body.textContent',
    sensitive: true,
    guardTtlSeconds: 300,
  });
  assert.match(String(worker.nativeMessages.find((message) => message.id === 30)?.error), /details suppressed/);
  assert.equal(worker.debuggerSendCalls(), 0);
});

test('worker startup fails closed when protected state cannot be restored', async () => {
  const worker = createWorker(new Map<string, unknown>(), { storageReadsFailing: true });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 35, action: 'queryTabs' });
  assert.match(
    String(worker.nativeMessages.find((message) => message.id === 35)?.error),
    /protected-tab state is unavailable/,
  );
  assert.equal(worker.queryTabsCalls(), 0);
});

test('relay revocation closes the old transport and ignores its queued messages', async () => {
  const storage = new Map<string, unknown>();
  const worker = createWorker(storage);
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({
    event: 'relayConfig',
    relay: {
      instance: 'default',
      wsPort: 43112,
      apiKey: TEST_API_KEY,
      pid: 1234,
      startedAt: new Date().toISOString(),
    },
  });
  await worker.nativeOnDisconnect.emit();
  await flushWorkerTasks();
  const oldSocket = worker.sockets[0];
  oldSocket.open();
  const queuedHandler = oldSocket.onmessage;

  await worker.nativeOnMessage.emit({ event: 'relayConfigUnavailable' });
  assert.equal(oldSocket.readyState, 3);
  assert.equal(oldSocket.onmessage, null);
  await queuedHandler?.({ data: JSON.stringify({ id: 40, action: 'queryTabs' }) });
  assert.equal(worker.queryTabsCalls(), 0);

  await worker.nativeOnDisconnect.emit();
  await flushWorkerTasks();
  assert.equal(worker.sockets.length, 1, 'revoked relay unexpectedly reconnected');
});

test('relay rotation invalidates the old transport before connecting with the new key', async () => {
  const storage = new Map<string, unknown>();
  const worker = createWorker(storage);
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({
    event: 'relayConfig',
    relay: { instance: 'default', wsPort: 43112, apiKey: TEST_API_KEY, pid: 1, startedAt: new Date().toISOString() },
  });
  await worker.nativeOnDisconnect.emit();
  await flushWorkerTasks();
  const oldSocket = worker.sockets[0];
  oldSocket.open();

  const rotatedKey = 'rotated-key-0123456789abcdef012345';
  await worker.nativeOnMessage.emit({
    event: 'relayConfig',
    relay: { instance: 'default', wsPort: 43113, apiKey: rotatedKey, pid: 2, startedAt: new Date().toISOString() },
  });
  assert.equal(oldSocket.readyState, 3);
  await worker.nativeOnDisconnect.emit();
  await flushWorkerTasks();
  assert.equal(worker.sockets.length, 2);
  const rotatedUrl = new URL(worker.sockets[1].url);
  assert.equal(rotatedUrl.port, '43113');
  assert.equal(rotatedUrl.searchParams.get('key'), rotatedKey);
});

// ── Batch allowlist and payload contract ───────────────────────────────────

/** The batch allowlist as the running worker holds it. */
function extensionBatchActions(): string[] {
  const worker = createWorker(new Map());
  return Array.from(vm.runInContext('ALLOWED_BATCH_ACTIONS', worker.context) as Iterable<string>);
}

async function runNative(message: Record<string, unknown>) {
  const worker = createWorker(new Map());
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 1, ...message });
  const response = worker.nativeMessages.find((m) => m.id === 1) as Record<string, any>;
  return { response, queryTabsCalls: worker.queryTabsCalls };
}

async function runNativeBatch(batch: Record<string, unknown>) {
  return (await runNative({ action: 'batch', ...batch })).response;
}

/** Captures the body a pi tool sends; the IPC and relay paths send the same one. */
async function piRequestBody(tool: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tools: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }> = {};
  chromeControllerPiExtension({ registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => { tools[t.name] = t; } } as never);
  const saved = { url: process.env.CHROME_CONTROLLER_URL, key: process.env.CHROME_CONTROLLER_API_KEY, fetch: global.fetch };
  process.env.CHROME_CONTROLLER_URL = 'http://127.0.0.1:8898';
  process.env.CHROME_CONTROLLER_API_KEY = TEST_API_KEY;
  let sent: Record<string, unknown> | undefined;
  global.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return { ok: true, status: 200, json: async () => ({ success: true, result: {} }) } as Response;
  }) as typeof fetch;
  try {
    await tools[tool].execute('call_1', params, undefined);
  } finally {
    global.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.CHROME_CONTROLLER_URL; else process.env.CHROME_CONTROLLER_URL = saved.url;
    if (saved.key === undefined) delete process.env.CHROME_CONTROLLER_API_KEY; else process.env.CHROME_CONTROLLER_API_KEY = saved.key;
  }
  assert.ok(sent, `${tool} sent nothing`);
  return sent;
}

test('the extension and the relay admit the same batch actions', async () => {
  const { ALLOWED_BATCH_ACTIONS } = await import('./server.js');
  // No intended differences: an action one side admits and the other refuses
  // makes a batch's fate depend on the transport it took.
  assert.deepEqual(extensionBatchActions().sort(), [...ALLOWED_BATCH_ACTIONS].sort());
});

test('actions kept out of batches stay out, and the gate refuses them', async () => {
  // Each has a handler in the worker, so only the allowlist keeps it out.
  for (const action of ['batch', 'createWindow', 'screenshot']) {
    assert.ok(!extensionBatchActions().includes(action), action);
    const response = await runNativeBatch({ actions: [{ action: 'queryTabs' }, { action, tabId: 42, actions: [] }] });
    assert.match(String(response?.error), /Batch item 1 (specifies disallowed action|cannot be a nested batch)/, action);
  }
});

test('every batch-allowlisted action has a handler in the real worker', async () => {
  const actions = extensionBatchActions();
  assert.ok(actions.length > 0);
  for (const action of actions) {
    // Short timings keep getConsoleLogs and captureVideo from waiting.
    const response = await runNativeBatch({
      mode: 'sequential',
      actions: [{ action, tabId: 42, timeoutMs: 1, fps: 1, duration: 1 }],
    });
    assert.equal(response?.error, undefined, `${action}: ${String(response?.error)}`);
    const [item] = response.result.results;
    assert.equal(item.action, action);
    assert.doesNotMatch(String(item.error ?? ''), /Unknown action/, action);
  }
});

test('an unhandled action name is refused by the batch gate, not reported as unknown', async () => {
  for (const action of ['clickElement', 'typeText', 'navigate', 'click', 'type']) {
    const response = await runNativeBatch({ actions: [{ action, tabId: 42 }] });
    assert.match(String(response?.error), new RegExp(`disallowed action "${action}"`), action);
  }
});

test('overlay actions work as batch items', async () => {
  const response = await runNativeBatch({
    mode: 'sequential',
    actions: [{ action: 'setOverlayHidden', hidden: true }, { action: 'getOverlayState' }],
  });
  assert.equal(response?.result?.success, true, JSON.stringify(response));
  assert.equal(response.result.results[1].result.overlayHidden, true);
});

test('a native batch honours mode and stopOnError', async () => {
  // visualizeAction without a tabId fails in the worker.
  const items = [{ action: 'visualizeAction' }, { action: 'queryTabs' }];
  const stopped = await runNativeBatch({ mode: 'sequential', commands: items });
  assert.equal(stopped.result.mode, 'sequential');
  assert.deepEqual(stopped.result.results.map((r: { success: boolean }) => r.success), [false]);
  const continued = await runNativeBatch({ mode: 'sequential', stopOnError: false, commands: items });
  assert.deepEqual(continued.result.results.map((r: { success: boolean }) => r.success), [false, true]);
  const parallel = await runNativeBatch({ commands: items });
  assert.equal(parallel.result.mode, 'parallel');
  assert.deepEqual(parallel.result.results.map((r: { success: boolean }) => r.success), [false, true]);
});

test('a native batch takes its items from exactly one array under actions or commands', async () => {
  for (const key of ['actions', 'commands']) {
    const response = await runNativeBatch({ [key]: [{ action: 'queryTabs' }] });
    assert.equal(response?.result?.success, true, `${key}: ${JSON.stringify(response)}`);
  }
  for (const actions of [false, 0, '', null]) {
    const withCommands = await runNativeBatch({ actions, commands: [{ action: 'queryTabs' }] });
    assert.match(String(withCommands?.error), /either actions or commands/, JSON.stringify(actions));
    const alone = await runNativeBatch({ actions });
    assert.match(String(alone?.error), /actions array/, JSON.stringify(actions));
  }
  const both = await runNativeBatch({ actions: [{ action: 'queryTabs' }], commands: [{ action: 'queryTabs' }] });
  assert.match(String(both?.error), /either actions or commands/);
  assert.match(String((await runNativeBatch({}))?.error), /actions array/);
});

test('the worker decides what is a batch the same way the relay does', async () => {
  // No action plus an item list is a batch, as on the relay.
  for (const key of ['actions', 'commands']) {
    const { response, queryTabsCalls } = await runNative({ [key]: [{ action: 'queryTabs' }] });
    assert.equal(response?.result?.success, true, `${key}: ${JSON.stringify(response)}`);
    assert.equal(queryTabsCalls(), 1, key);
  }
  // Any other action carrying an item list is refused before it runs.
  for (const key of ['actions', 'commands']) {
    const { response, queryTabsCalls } = await runNative({ action: 'queryTabs', [key]: [{ action: 'queryTabs' }] });
    assert.match(String(response?.error), /Only a batch can carry/, key);
    assert.equal(queryTabsCalls(), 0, key);
  }
  const nested = await runNativeBatch({ actions: [{ action: 'queryTabs', commands: [{ action: 'queryTabs' }] }] });
  assert.match(String(nested.result.results[0].error), /Only a batch can carry/);
});

test('pi chrome_batch runs in the real worker', async () => {
  const body = await piRequestBody('chrome_batch', { mode: 'sequential', actions: [{ action: 'queryTabs' }] });
  // The worker in users' browsers predates the rule above and runs a body as a
  // batch only when it names action "batch".
  assert.equal(body.action, 'batch');
  const { response, queryTabsCalls } = await runNative(body);
  assert.equal(response?.result?.success, true, JSON.stringify(response));
  assert.equal(queryTabsCalls(), 1);
});
