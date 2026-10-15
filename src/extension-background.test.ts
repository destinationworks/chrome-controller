import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CHROME_WAIT_MS,
  FRAME_CAPTURE_ALLOWANCE_MS,
  KEYSTROKE_ALLOWANCE_MS,
  chromeWaitMs,
  chromeWorkMs,
} from './chrome-wait.js';
import { buildMouseBatch, buildTypeTextBatch } from './mcp.js';
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
    clear() { listeners.length = 0; },
  };
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function createWorker(
  sharedStorage: Map<string, unknown>,
  options: {
    debuggerSendCommand?: (target: unknown, method: string, params?: unknown) => Promise<unknown>;
    tabsSendMessage?: (tabId: number, message: Record<string, unknown>) => Promise<unknown>;
    now?: () => number;
    storageReadsFailing?: boolean;
    timers?: { setTimeout: (fn: () => void, ms?: number) => unknown; clearTimeout: (id: unknown) => void };
    math?: Math;
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
  const chromeTouches: string[] = [];
  let nativeConnects = 0;
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
      // Each connect is a fresh port: the previous port's listeners are gone.
      connectNative: () => {
        nativeConnects += 1;
        nativeOnMessage.clear();
        nativeOnDisconnect.clear();
        return nativePort;
      },
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
      async sendMessage(tabId: number, message: Record<string, unknown>) {
        return options.tabsSendMessage ? options.tabsSendMessage(tabId, message) : { success: true };
      },
      async group() { chromeTouches.push('tabs.group'); return 1; },
      async remove() { removeTabCalls += 1; },
      async update() { chromeTouches.push('tabs.update'); return {}; },
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
      async attach() { chromeTouches.push('debugger.attach'); },
      async detach() {},
      async sendCommand(target: unknown, method: string, params?: unknown) {
        debuggerSendCalls += 1;
        return options.debuggerSendCommand ? options.debuggerSendCommand(target, method, params) : {};
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
    setTimeout: options.timers?.setTimeout ?? setTimeout,
    clearTimeout: options.timers?.clearTimeout ?? clearTimeout,
    queueMicrotask,
    structuredClone,
    ...(options.math ? { Math: options.math } : {}),
  });
  vm.runInContext(backgroundSource, context, { filename: backgroundPath });

  return {
    alarmEvent,
    alarmState,
    context,
    debuggerOnEvent,
    debuggerSendCalls: () => debuggerSendCalls,
    chromeTouches: () => [...chromeTouches],
    nativeConnects: () => nativeConnects,
    nativeMessages,
    nativeOnDisconnect,
    nativeOnMessage,
    nativePort,
    queryTabsCalls: () => queryTabsCalls,
    removeTabCalls: () => removeTabCalls,
    setStorageWritesFailing(value: boolean) { storageWritesFailing = value; },
    sockets: WebSocketMock.instances,
    tabRemoved,
  };
}

async function flushWorkerTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const contentActions = ['clickSelector', 'fillSelector', 'selectOption', 'snapshotElements', 'getPageErrors'];

test('content actions reject invalid tab IDs before touching Chrome', async () => {
  for (const action of contentActions) {
    for (const tabId of [undefined, null, 0, -1, 1.5, '42', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      let sends = 0;
      const worker = createWorker(new Map(), { tabsSendMessage: async () => { sends += 1; return { success: true }; } });
      await flushWorkerTasks();
      await worker.nativeOnMessage.emit({ id: 150, action, tabId, selector: '#message' });
      const reply = worker.nativeMessages.find(message => message.id === 150);
      assert.match(String(reply?.error), /requires a positive integer tabId/, `${action}/${String(tabId)}`);
      assert.equal(sends, 0);
      assert.deepEqual(worker.chromeTouches(), []);
    }
  }
});

test('a missing DOM batch target rejects the whole batch before its first item', async () => {
  for (const mode of ['sequential', 'parallel']) {
    const worker = createWorker(new Map());
    await flushWorkerTasks();
    await worker.nativeOnMessage.emit({ id: 151, action: 'batch', mode, stopOnError: false, actions: [
      { action: 'queryTabs' }, { action: 'clickSelector', selector: '#message' },
      { action: 'sendCommand', tabId: 42, method: 'Input.insertText', commandParams: { text: 'synthetic' } },
    ] });
    const reply = worker.nativeMessages.find(message => message.id === 151);
    assert.match(String(reply?.error), /requires a positive integer tabId/);
    assert.equal(worker.queryTabsCalls(), 0);
    assert.equal(worker.debuggerSendCalls(), 0);
    assert.deepEqual(worker.chromeTouches(), []);
  }
});

test('content actions require an explicit successful content-script acknowledgement', async () => {
  for (const action of contentActions) {
    const canary = 'synthetic-private-content-error';
    for (const outcome of ['unavailable', undefined, null, {}, { success: 'true', value: canary },
      { success: 1, value: canary }, { success: false, error: canary }]) {
      const worker = createWorker(new Map(), { tabsSendMessage: async (_tabId, message) => {
        if (message.action !== action) return { success: true };
        if (outcome === 'unavailable') throw new Error(canary);
        return outcome;
      } });
      await flushWorkerTasks();
      await worker.nativeOnMessage.emit({ id: 152, action, tabId: 42, selector: '#message' });
      const reply = worker.nativeMessages.find(message => message.id === 152);
      assert.match(String(reply?.error), /Content action .* failed/, `${action}/${JSON.stringify(outcome)}`);
      assert.equal(reply?.result, undefined);
      assert.equal(JSON.stringify(reply).includes(canary), false);
    }
  }
});

test('content actions preserve successful empty and populated acknowledgements', async () => {
  for (const action of contentActions) {
    const acknowledgement = { success: true, elements: [], count: 0, value: 'synthetic' };
    const worker = createWorker(new Map(), { tabsSendMessage: async () => acknowledgement });
    await flushWorkerTasks();
    await worker.nativeOnMessage.emit({ id: 153, action, tabId: 42, selector: '#message' });
    const reply = worker.nativeMessages.find(message => message.id === 153);
    assert.equal(reply?.error, undefined);
    assert.deepEqual(reply?.result, acknowledgement);
  }
});

test('a failed content acknowledgement stops the remaining sequential batch items', async () => {
  const worker = createWorker(new Map(), { tabsSendMessage: async (_tabId, message) =>
    message.action === 'clickSelector' ? { success: false, error: 'synthetic selector failure' } : { success: true },
  });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 154, action: 'batch', mode: 'sequential', actions: [
    { action: 'clickSelector', tabId: 42, selector: '#missing' }, { action: 'queryTabs' },
  ] });
  const reply = worker.nativeMessages.find(message => message.id === 154);
  const result = reply?.result as { success: boolean; results: { success: boolean; error?: string }[] };
  assert.equal(result.success, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.success, false);
  assert.match(String(result.results[0]?.error), /Content action clickSelector failed/);
  assert.equal(worker.queryTabsCalls(), 0);
});

test('optional HUD delivery does not prevent an independent CDP action', async () => {
  const worker = createWorker(new Map(), { tabsSendMessage: async () => { throw new Error('synthetic HUD unavailable'); } });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 155, action: 'ensureDebugger', tabId: 42 });
  const reply = worker.nativeMessages.find(message => message.id === 155);
  assert.equal(reply?.error, undefined);
  assert.deepEqual(reply?.result, { success: true });
  assert.ok(worker.chromeTouches().includes('debugger.attach'));
  await worker.nativeOnMessage.emit({ id: 156, action: 'sendCommand', tabId: 42,
    method: 'Input.insertText', commandParams: { text: 'synthetic' } });
  const inserted = worker.nativeMessages.find(message => message.id === 156);
  assert.equal(inserted?.error, undefined);
  assert.equal(worker.debuggerSendCalls(), 1);
  assert.deepEqual(inserted?.result, {});
});

test('stopOnError false continues after a content failure while retaining aggregate failure', async () => {
  const worker = createWorker(new Map(), { tabsSendMessage: async (_tabId, message) =>
    message.action === 'clickSelector' ? { success: false } : { success: true },
  });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 157, action: 'batch', mode: 'sequential', stopOnError: false, actions: [
    { action: 'clickSelector', tabId: 42, selector: '#missing' }, { action: 'queryTabs' },
  ] });
  const reply = worker.nativeMessages.find(message => message.id === 157);
  const result = reply?.result as { success: boolean; results: { success: boolean; result?: unknown }[] };
  assert.equal(result.success, false);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0]?.success, false);
  assert.equal(result.results[1]?.success, true);
  assert.deepEqual(result.results[1]?.result, []);
  assert.equal(worker.queryTabsCalls(), 1);
});

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

// ── Working time of long actions vs. the shared timeout budget ─────────────
//
// chrome-wait.ts mirrors the extension's defaults and loops to size the host's
// wait. These run the real worker on a virtual clock, with Chrome's latency set
// to the most the budget allows, to hold the two together: if the extension's
// loops or defaults change, the budget must change with them.

/**
 * A virtual clock for the worker's setTimeout. Time jumps to the next due timer
 * only after every promise chain started so far has settled, so `run` measures
 * exactly the worker's own sleeps plus the injected Chrome latencies.
 */
function virtualClock() {
  let now = 0;
  let nextId = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const setTimer = (fn: () => void, ms?: number) => {
    nextId += 1;
    // Browsers run a NaN or negative delay at once.
    due.set(nextId, { at: now + Math.max(0, Number(ms) || 0), fn });
    return nextId;
  };
  return {
    setTimeout: setTimer,
    clearTimeout(id: unknown) { due.delete(id as number); },
    /** A Chrome call that answers `value` after `ms` of virtual time. */
    latency<T>(ms: number, value: T): Promise<T> {
      return new Promise((resolve) => setTimer(() => resolve(value), ms));
    },
    async run(action: Promise<unknown>): Promise<number> {
      let settled = false;
      void action.then(() => { settled = true; }, () => { settled = true; });
      const start = now;
      for (;;) {
        await flushWorkerTasks();
        if (settled) return now - start;
        let nextKey = 0;
        let next: { at: number; fn: () => void } | undefined;
        for (const [key, timer] of due) {
          if (!next || timer.at < next.at) { next = timer; nextKey = key; }
        }
        if (!next) throw new Error('the worker went idle without answering');
        due.delete(nextKey);
        now = next.at;
        next.fn();
      }
    },
  };
}

async function timeNativeAction(
  clock: ReturnType<typeof virtualClock>,
  worker: ReturnType<typeof createWorker>,
  request: Record<string, unknown>,
): Promise<{ elapsed: number; response: Record<string, any> | undefined }> {
  await flushWorkerTasks();
  const elapsed = await clock.run(worker.nativeOnMessage.emit(request));
  return { elapsed, response: worker.nativeMessages.find((message) => message.id === request.id) };
}

test('captureVideo at the slowest frame the budget allows finishes within its budgeted work', async () => {
  for (const params of [{}, { fps: 10, duration: 3 }, { fps: 30, duration: 2 }]) {
    const clock = virtualClock();
    const worker = createWorker(new Map(), {
      timers: clock,
      debuggerSendCommand: (_target, method) => method === 'Page.captureScreenshot'
        ? clock.latency(FRAME_CAPTURE_ALLOWANCE_MS, { data: 'frame' })
        : Promise.resolve({}),
    });
    const request = { id: 1, action: 'captureVideo', tabId: 42, ...params };
    const { elapsed, response } = await timeNativeAction(clock, worker, request);
    const work = chromeWorkMs('captureVideo', request);
    const label = JSON.stringify(params);
    assert.equal(response?.error, undefined, label);
    assert.ok(response?.result.count > 0, `${label}: frames were captured`);
    assert.equal(response?.result.frames.filter((frame: { error?: string }) => frame.error).length, 0, label);
    assert.ok(elapsed <= work, `${label}: took ${elapsed}ms, budgeted ${work}ms`);
    // Tight, not vacuous: only the interval after the last frame goes unspent.
    const intervalMs = Math.round(1000 / response?.result.fps);
    assert.equal(elapsed, work - intervalMs, `${label}: worst case realized`);
  }
});

test('getConsoleLogs answers only after its whole window, so the window alone can never be the wait', async () => {
  for (const params of [{}, { timeoutMs: 3000 }]) {
    const attachLatencyMs = 1000;
    const clock = virtualClock();
    const worker = createWorker(new Map(), {
      timers: clock,
      debuggerSendCommand: (_target, method) => method === 'Runtime.enable'
        ? clock.latency(attachLatencyMs, {})
        : Promise.resolve({}),
    });
    const request = { id: 1, action: 'getConsoleLogs', tabId: 42, ...params };
    const { elapsed, response } = await timeNativeAction(clock, worker, request);
    const label = JSON.stringify(params);
    assert.deepEqual(response?.result, { logs: [], count: 0 }, label);
    assert.equal(elapsed, chromeWorkMs('getConsoleLogs', request) + attachLatencyMs, `${label}: window plus setup`);
    // What the host used to wait: the window itself, which always loses.
    assert.ok(elapsed > Number(params.timeoutMs ?? 2000), label);
    assert.ok(elapsed < chromeWaitMs('getConsoleLogs', request), `${label}: the host now outwaits it`);
  }
});

test('animated typing at the slowest keystroke the budget allows finishes within its budgeted work', async () => {
  // Every key a pause key, and Math.random at its maximum: the extension's worst case.
  const text = ',.!?;: '.repeat(6);
  for (const typingDelayMs of [undefined, 12, 50, 240]) {
    const clock = virtualClock();
    const math = Object.create(Math) as Math;
    math.random = () => 1 - Number.EPSILON;
    const halfKeystroke = KEYSTROKE_ALLOWANCE_MS / 2;
    const worker = createWorker(new Map(), {
      timers: clock,
      math,
      debuggerSendCommand: (_target, method) => method === 'Input.insertText'
        ? clock.latency(halfKeystroke, {})
        : Promise.resolve({}),
      tabsSendMessage: (_tabId, message) => message.action === 'visualizeAction'
        ? clock.latency(halfKeystroke, {})
        : Promise.resolve({}),
    });
    const request = {
      id: 1,
      action: 'sendCommand',
      tabId: 42,
      method: 'Input.insertText',
      commandParams: { text, animateTyping: true, typingDelayMs, sound: false },
    };
    const { elapsed, response } = await timeNativeAction(clock, worker, request);
    const work = chromeWorkMs('sendCommand', request);
    const label = `typingDelayMs ${String(typingDelayMs)}`;
    assert.equal(response?.error, undefined, label);
    assert.equal(elapsed, work, `${label}: took ${elapsed}ms, budgeted ${work}ms`);
  }
});

test('a batch of long actions finishes within its budgeted work in either mode', async () => {
  for (const mode of ['sequential', 'parallel']) {
    const clock = virtualClock();
    const worker = createWorker(new Map(), {
      timers: clock,
      debuggerSendCommand: (_target, method) => method === 'Page.captureScreenshot'
        ? clock.latency(FRAME_CAPTURE_ALLOWANCE_MS, { data: 'frame' })
        : Promise.resolve({}),
    });
    const request = {
      id: 1,
      action: 'batch',
      mode,
      actions: [
        { action: 'captureVideo', tabId: 42 },
        { action: 'getConsoleLogs', tabId: 42, timeoutMs: 3000 },
      ],
    };
    const { elapsed, response } = await timeNativeAction(clock, worker, request);
    assert.equal(response?.result.success, true, mode);
    const work = chromeWorkMs('batch', request);
    assert.ok(elapsed <= work, `${mode}: took ${elapsed}ms, budgeted ${work}ms`);
    assert.ok(elapsed < DEFAULT_CHROME_WAIT_MS + work, mode);
  }
});

test('a batch of 40 ordinary actions at measured latency fits its per-item allowance', async () => {
  // ~450 ms per ordinary action was measured on a live Chrome, so 40 of them
  // take 18 s: more than one ordinary 15 s round trip.
  const measuredActionMs = 450;
  const clock = virtualClock();
  const worker = createWorker(new Map(), {
    timers: clock,
    debuggerSendCommand: () => clock.latency(measuredActionMs, { data: 'png' }),
  });
  const request = {
    id: 1,
    action: 'batch',
    mode: 'sequential',
    actions: Array.from({ length: 40 }, () => ({ action: 'captureScreenshot', tabId: 42 })),
  };
  const { elapsed, response } = await timeNativeAction(clock, worker, request);
  assert.equal(response?.result.success, true);
  assert.equal(elapsed, 40 * measuredActionMs);
  assert.ok(elapsed > DEFAULT_CHROME_WAIT_MS, 'the ordinary wait alone would not cover it');
  assert.ok(elapsed < chromeWaitMs('batch', request), `took ${elapsed}ms, host waits ${chromeWaitMs('batch', request)}ms`);
});

// ── CDP input commands inside batches ──────────────────────────────────────
//
// chrome_type_text and chrome_mouse (MCP and pi) send their CDP input as
// `sendCommand` items of a batch. The batch allowlist must admit exactly those
// input methods and nothing else of raw CDP.

async function runNativeBatch(batch: Record<string, unknown>) {
  const cdpCalls: { method: string; params: any }[] = [];
  const worker = createWorker(new Map(), {
    debuggerSendCommand: async (_target, method, params) => { cdpCalls.push({ method, params }); return {}; },
  });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 1, action: 'batch', ...batch });
  const response = worker.nativeMessages.find((message) => message.id === 1) as Record<string, any>;
  return { response, cdpCalls, debuggerSendCalls: worker.debuggerSendCalls, chromeTouches: worker.chromeTouches };
}

/** Captures the payload a pi tool sends to the relay. */
async function piPayload(tool: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
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

test('chrome_type_text batches run in the real worker and reach CDP', async () => {
  const payloads = {
    'mcp': buildTypeTextBatch({ tabId: 42, text: 'hi', instant: true }),
    'pi': await piPayload('chrome_type_text', { tabId: 42, text: 'hi', instant: true }),
  };
  for (const [client, batch] of Object.entries(payloads)) {
    const { response, cdpCalls } = await runNativeBatch(batch);
    assert.equal(response?.error, undefined, `${client}: ${String(response?.error)}`);
    assert.equal(response?.result.success, true, `${client}: ${JSON.stringify(response?.result)}`);
    assert.deepEqual(cdpCalls.filter((call) => call.method === 'Input.insertText').map((call) => call.params.text), ['hi'], client);
  }
});

test('chrome_type_text animated typing inside a batch types every character', async () => {
  const { response, cdpCalls } = await runNativeBatch(buildTypeTextBatch({ tabId: 42, text: 'ok', typingDelayMs: 12, sound: false }));
  assert.equal(response?.result.success, true, JSON.stringify(response?.result));
  assert.deepEqual(cdpCalls.filter((call) => call.method === 'Input.insertText').map((call) => call.params.text), ['o', 'k']);
});

test('chrome_mouse batches run in the real worker for every mouse type', async () => {
  const expected: Record<string, string[]> = {
    click: ['mouseMoved', 'mousePressed', 'mouseReleased'],
    move: ['mouseMoved'],
    press: ['mousePressed'],
    release: ['mouseReleased'],
  };
  for (const [type, events] of Object.entries(expected)) {
    const payloads = {
      mcp: buildMouseBatch({ tabId: 42, action: type, x: 10, y: 20 }),
      pi: await piPayload('chrome_mouse', { tabId: 42, type, x: 10, y: 20 }),
    };
    for (const [client, batch] of Object.entries(payloads)) {
      const { response, cdpCalls } = await runNativeBatch(batch);
      const label = `${client} ${type}`;
      assert.equal(response?.result?.success, true, `${label}: ${JSON.stringify(response)}`);
      assert.deepEqual(
        cdpCalls.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params.type),
        events,
        label,
      );
    }
  }
});

/** Raw CDP a batch must refuse: other domains, the other Input methods, and
 *  anything that only resembles an admitted method. */
const REFUSED_BATCH_METHODS: unknown[] = [
  'Runtime.evaluate',
  'Page.navigate',
  'Network.getAllCookies',
  undefined,
  // Siblings of the admitted methods: key events, drag data (which can carry
  // file paths), and switching input off are all outside what the tools need.
  'Input.dispatchKeyEvent',
  'Input.dispatchDragEvent',
  'Input.setIgnoreInputEvents',
  'Input.dispatchTouchEvent',
  ['Input.insertText'],
  'input.insertText',
  'Input.insertText ',
  7,
  { toString: 'Input.insertText' },
];

test('a batch still refuses raw CDP beyond the input methods, before touching Chrome', async () => {
  for (const mode of ['sequential', 'parallel']) {
    for (const method of REFUSED_BATCH_METHODS) {
      const { response, debuggerSendCalls, chromeTouches } = await runNativeBatch({
        mode,
        actions: [{ action: 'ensureDebugger', tabId: 42 }, { action: 'sendCommand', tabId: 42, method }],
      });
      const label = `${mode} ${JSON.stringify(method)}`;
      assert.match(String(response?.error), /Batch item 1 sends CDP method .* which batches do not allow/, label);
      assert.equal(debuggerSendCalls(), 0, `${label}: no CDP command ran`);
      assert.deepEqual(chromeTouches(), [], `${label}: the debugger was not attached, nor the tab grouped`);
    }
  }
});

test('the MCP input batches carry exactly what the tools were asked for', () => {
  const mouse = (args: Record<string, unknown>) => buildMouseBatch({ tabId: 42, x: 10, y: 20, ...args }).actions as any[];
  const click = mouse({ action: 'click' });
  assert.deepEqual(click[0], { action: 'ensureDebugger', tabId: 42 });
  assert.deepEqual(click.slice(1).map((item) => item.commandParams), [
    { type: 'mouseMoved', x: 10, y: 20, button: 'none' },
    { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', x: 10, y: 20, button: 'left', clickCount: 1 },
  ]);
  assert.ok(click.slice(1).every((item) => item.action === 'sendCommand' && item.tabId === 42 && item.method === 'Input.dispatchMouseEvent'));
  assert.deepEqual(mouse({ type: 'press', button: 'right', clickCount: 2 })[1].commandParams, { type: 'mousePressed', x: 10, y: 20, button: 'right', clickCount: 2 });
  assert.deepEqual(mouse({ type: 'move' })[1].commandParams, { type: 'mouseMoved', x: 10, y: 20, button: 'none' });
  // `type` wins over the legacy `action` name, and click is the default.
  assert.equal(mouse({ type: 'release', action: 'click' }).length, 2);
  assert.equal(mouse({}).length, 4);

  const typed = (args: Record<string, unknown>) => (buildTypeTextBatch({ tabId: 42, text: 'hi', ...args }).actions as any[])[1];
  assert.deepEqual(typed({}), {
    action: 'sendCommand',
    tabId: 42,
    method: 'Input.insertText',
    commandParams: { text: 'hi', animateTyping: true, typingDelayMs: 50, sound: true },
  });
  assert.deepEqual(typed({ instant: true, typingDelayMs: 20, sound: false }).commandParams, { text: 'hi', animateTyping: false, typingDelayMs: 20, sound: false });
  assert.equal(buildTypeTextBatch({ tabId: 42, text: 'hi' }).mode, 'sequential');
});

test('the extension and the relay admit the same CDP methods in batches', async () => {
  const { BATCH_CDP_METHODS } = await import('./server.js');
  const declared = backgroundSource.match(/const BATCH_CDP_METHODS = new Set\((\[[^\]]*\])\);/);
  assert.ok(declared, 'BATCH_CDP_METHODS is declared in background.js');
  const extensionMethods = JSON.parse(declared[1].replace(/'/g, '"')) as string[];
  assert.deepEqual([...extensionMethods].sort(), [...BATCH_CDP_METHODS].sort());
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

/** The worker's answer to one native batch. */
async function nativeBatchResponse(batch: Record<string, unknown>) {
  return (await runNativeBatch(batch)).response;
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
    const response = await nativeBatchResponse({ actions: [{ action: 'queryTabs' }, { action, tabId: 42, actions: [] }] });
    assert.match(String(response?.error), /Batch item 1 (specifies disallowed action|cannot be a nested batch)/, action);
  }
});

test('every batch-allowlisted action has a handler in the real worker', async () => {
  const actions = extensionBatchActions();
  assert.ok(actions.length > 0);
  for (const action of actions) {
    // Short timings keep getConsoleLogs and captureVideo from waiting, and
    // sendCommand needs a method batches admit.
    const response = await nativeBatchResponse({
      mode: 'sequential',
      actions: [{ action, tabId: 42, timeoutMs: 1, fps: 1, duration: 1, method: 'Input.dispatchMouseEvent', commandParams: { type: 'mouseMoved', x: 1, y: 1 } }],
    });
    assert.equal(response?.error, undefined, `${action}: ${String(response?.error)}`);
    const [item] = response.result.results;
    assert.equal(item.action, action);
    assert.doesNotMatch(String(item.error ?? ''), /Unknown action/, action);
  }
});

test('an unhandled action name is refused by the batch gate, not reported as unknown', async () => {
  for (const action of ['clickElement', 'typeText', 'navigate', 'click', 'type']) {
    const response = await nativeBatchResponse({ actions: [{ action, tabId: 42 }] });
    assert.match(String(response?.error), new RegExp(`disallowed action "${action}"`), action);
  }
});

test('overlay actions work as batch items', async () => {
  const response = await nativeBatchResponse({
    mode: 'sequential',
    actions: [{ action: 'setOverlayHidden', hidden: true }, { action: 'getOverlayState' }],
  });
  assert.equal(response?.result?.success, true, JSON.stringify(response));
  assert.equal(response.result.results[1].result.overlayHidden, true);
});

test('a native batch honours mode and stopOnError', async () => {
  // visualizeAction without a tabId fails in the worker.
  const items = [{ action: 'visualizeAction' }, { action: 'queryTabs' }];
  const stopped = await nativeBatchResponse({ mode: 'sequential', commands: items });
  assert.equal(stopped.result.mode, 'sequential');
  assert.deepEqual(stopped.result.results.map((r: { success: boolean }) => r.success), [false]);
  const continued = await nativeBatchResponse({ mode: 'sequential', stopOnError: false, commands: items });
  assert.deepEqual(continued.result.results.map((r: { success: boolean }) => r.success), [false, true]);
  const parallel = await nativeBatchResponse({ commands: items });
  assert.equal(parallel.result.mode, 'parallel');
  assert.deepEqual(parallel.result.results.map((r: { success: boolean }) => r.success), [false, true]);
});

test('a native batch takes its items from exactly one array under actions or commands', async () => {
  for (const key of ['actions', 'commands']) {
    const response = await nativeBatchResponse({ [key]: [{ action: 'queryTabs' }] });
    assert.equal(response?.result?.success, true, `${key}: ${JSON.stringify(response)}`);
  }
  for (const actions of [false, 0, '', null]) {
    const withCommands = await nativeBatchResponse({ actions, commands: [{ action: 'queryTabs' }] });
    assert.match(String(withCommands?.error), /either actions or commands/, JSON.stringify(actions));
    const alone = await nativeBatchResponse({ actions });
    assert.match(String(alone?.error), /actions array/, JSON.stringify(actions));
  }
  const both = await nativeBatchResponse({ actions: [{ action: 'queryTabs' }], commands: [{ action: 'queryTabs' }] });
  assert.match(String(both?.error), /either actions or commands/);
  assert.match(String((await nativeBatchResponse({}))?.error), /actions array/);
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
  const nested = await nativeBatchResponse({ actions: [{ action: 'queryTabs', commands: [{ action: 'queryTabs' }] }] });
  assert.match(String(nested.result.results[0].error), /Only a batch can carry/);
});

test('pi chrome_batch runs in the real worker', async () => {
  const body = await piPayload('chrome_batch', { mode: 'sequential', actions: [{ action: 'queryTabs' }] });
  // The worker in users' browsers predates the rule above and runs a body as a
  // batch only when it names action "batch".
  assert.equal(body.action, 'batch');
  const { response, queryTabsCalls } = await runNative(body);
  assert.equal(response?.result?.success, true, JSON.stringify(response));
  assert.equal(queryTabsCalls(), 1);
});

// A CDP stub that records every command and holds any command whose expression
// (or input event type) was passed to hold(), so a guard can land while it waits.
function cdpRecorder() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const held = new Map<string, PromiseWithResolvers<unknown>>();
  return {
    calls,
    hold(expression: string) {
      const gate = Promise.withResolvers<unknown>();
      held.set(expression, gate);
      return gate;
    },
    send(_target: unknown, method: string, params?: unknown) {
      const commandParams = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: commandParams });
      const gate = held.get(String(commandParams.expression ?? commandParams.type));
      if (gate) return gate.promise;
      return Promise.resolve({ result: { value: `page:${String(commandParams.expression ?? method)}` } });
    },
    evaluated() {
      return calls.filter((call) => call.method === 'Runtime.evaluate').map((call) => call.params.expression);
    },
    screenshots() {
      return calls.filter((call) => call.method === 'Page.captureScreenshot').length;
    },
  };
}

// Both transports live at once: the native host drops, the worker falls back to
// the relay, and the reconnect alarm fires while that socket is still connecting,
// so the native port comes back too.
async function openRelayBesideNative(worker: ReturnType<typeof createWorker>) {
  await worker.nativeOnMessage.emit({
    event: 'relayConfig',
    relay: { instance: 'default', wsPort: 43112, apiKey: TEST_API_KEY, pid: 1, startedAt: new Date().toISOString() },
  });
  await worker.nativeOnDisconnect.emit();
  await flushWorkerTasks();
  const socket = worker.sockets.at(-1)!;
  await worker.alarmEvent.emit({ name: 'reconnect' });
  assert.equal(worker.nativeConnects(), 2);
  socket.open();
  return socket;
}

function relayReply(socket: ReturnType<typeof createWorker>['sockets'][number], id: number) {
  return socket.sent.map((message) => JSON.parse(message)).find((message) => message.id === id);
}

// Park on a slow read, then read the tab once a guarded extraction has made it
// protected. Natively this reaches the worker whole after the host's request
// timeout has dropped it; the relay splits batches into items, and forwards one
// whole only when `actions` is falsy and `commands` carries the list.
const raceBatch = [
  { action: 'ensureDebugger', tabId: 42 },
  { action: 'evaluateOnPage', tabId: 42, expression: 'slow-read' },
  { action: 'evaluateOnPage', tabId: 42, expression: 'document.body.innerText' },
  { action: 'captureScreenshot', tabId: 42 },
];

const guardedExtraction = {
  action: 'evaluateOnPage',
  tabId: 42,
  expression: 'guarded-extraction',
  sensitive: true,
  guardTtlSeconds: 300,
};

test('control: an unguarded sequential relay batch runs every item and returns its results', async () => {
  const cdp = cdpRecorder();
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send });
  await flushWorkerTasks();
  const socket = await openRelayBesideNative(worker);

  await socket.onmessage?.({
    data: JSON.stringify({ id: 50, action: 'batch', mode: 'sequential', stopOnError: false, actions: raceBatch }),
  });

  const reply = relayReply(socket, 50);
  assert.equal(reply?.error, undefined);
  assert.equal(reply?.result.success, true);
  assert.deepEqual(reply?.result.results.map((item: { action: string }) => item.action), raceBatch.map((item) => item.action));
  assert.deepEqual(cdp.evaluated(), ['slow-read', 'document.body.innerText']);
  assert.equal(cdp.screenshots(), 1);
});

test('a relay batch stops before its next item once a guarded extraction protects the tab mid-batch', async () => {
  const cdp = cdpRecorder();
  const slowRead = cdp.hold('slow-read');
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send });
  await flushWorkerTasks();
  const socket = await openRelayBesideNative(worker);

  // stopOnError: false proves the abort does not depend on the caller's error policy.
  const batch = socket.onmessage?.({
    data: JSON.stringify({ id: 51, action: 'batch', mode: 'sequential', stopOnError: false, actions: raceBatch }),
  });
  await flushWorkerTasks();
  assert.deepEqual(cdp.evaluated(), ['slow-read']);

  await worker.nativeOnMessage.emit({ id: 52, ...guardedExtraction });
  assert.equal(worker.nativeMessages.find((message) => message.id === 52)?.error, undefined);
  await socket.onmessage?.({ data: JSON.stringify({ id: 53, action: 'queryTabs' }) });
  assert.match(String(relayReply(socket, 53)?.error), /protected secret tab/);

  slowRead.resolve({ result: { value: 'synthetic-secret' } });
  await batch;

  assert.deepEqual(cdp.evaluated(), ['slow-read', 'guarded-extraction'], 'a batch item ran against the protected tab');
  assert.equal(cdp.screenshots(), 0, 'the protected tab was screenshotted');
  const reply = relayReply(socket, 51);
  assert.equal(reply?.error, 'Browser output is locked while a protected secret tab is active');
  assert.equal(reply?.result, undefined);
  assert.doesNotMatch(socket.sent.join('\n'), /synthetic-secret/);
});

test('the probe: a relay input batch sends no input to a tab protected mid-batch', async () => {
  const cdp = cdpRecorder();
  const mouseMoved = cdp.hold('mouseMoved');
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send });
  await flushWorkerTasks();
  const socket = await openRelayBesideNative(worker);
  const mouse = (type: string) => ({
    action: 'sendCommand',
    tabId: 42,
    method: 'Input.dispatchMouseEvent',
    commandParams: { type, x: 10, y: 10, button: 'left', clickCount: 1 },
  });

  const batch = socket.onmessage?.({
    data: JSON.stringify({
      id: 80,
      action: 'batch',
      mode: 'sequential',
      actions: [
        { action: 'ensureDebugger', tabId: 42 },
        mouse('mouseMoved'),
        mouse('mousePressed'),
        { action: 'sendCommand', tabId: 42, method: 'Input.insertText', commandParams: { text: 'attacker' } },
      ],
    }),
  });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 81, ...guardedExtraction });
  mouseMoved.resolve({});
  await batch;

  const input = cdp.calls.filter((call) => call.method.startsWith('Input.'));
  assert.deepEqual(input.map((call) => call.params.type), ['mouseMoved'], 'input reached the protected tab');
  assert.equal(relayReply(socket, 80)?.error, 'Browser output is locked while a protected secret tab is active');
});

test('a native batch stops mid-batch too: the worker does not rely on the host serializing requests', async () => {
  const cdp = cdpRecorder();
  const slowRead = cdp.hold('slow-read');
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send });
  await flushWorkerTasks();

  const batch = worker.nativeOnMessage.emit({ id: 54, action: 'batch', mode: 'sequential', actions: raceBatch });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 55, ...guardedExtraction });
  slowRead.resolve({ result: { value: 'synthetic-secret' } });
  await batch;

  assert.deepEqual(cdp.evaluated(), ['slow-read', 'guarded-extraction']);
  assert.equal(cdp.screenshots(), 0);
  const reply = worker.nativeMessages.find((message) => message.id === 54);
  assert.equal(reply?.error, 'Browser output is locked while a protected secret tab is active');
  assert.equal(reply?.result, undefined);
});

test('a batch stops mid-batch on the in-flight guarded-action depth alone', async () => {
  const cdp = cdpRecorder();
  const slowRead = cdp.hold('slow-read');
  const extraction = cdp.hold('guarded-extraction');
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send });
  await flushWorkerTasks();
  const socket = await openRelayBesideNative(worker);

  const batch = socket.onmessage?.({
    data: JSON.stringify({ id: 56, action: 'batch', mode: 'sequential', actions: raceBatch }),
  });
  await flushWorkerTasks();
  // A sensitive action with no integer tabId reserves no guard; only the
  // in-flight depth locks output.
  const sensitive = worker.nativeOnMessage.emit({ ...guardedExtraction, id: 57, tabId: undefined });
  await flushWorkerTasks();
  slowRead.resolve({ result: { value: 'page-text' } });
  await batch;

  assert.deepEqual(cdp.evaluated(), ['slow-read', 'guarded-extraction']);
  assert.equal(relayReply(socket, 56)?.error, 'Browser output is locked during guarded extraction');
  extraction.resolve({ result: { value: 'synthetic-secret' } });
  await sensitive;
});

test('a batch stops mid-batch when a guard reservation cannot be persisted', async () => {
  const cdp = cdpRecorder();
  const slowRead = cdp.hold('slow-read');
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send });
  await flushWorkerTasks();
  const socket = await openRelayBesideNative(worker);

  const batch = socket.onmessage?.({
    data: JSON.stringify({ id: 58, action: 'batch', mode: 'sequential', actions: raceBatch }),
  });
  await flushWorkerTasks();
  worker.setStorageWritesFailing(true);
  await worker.nativeOnMessage.emit({ id: 59, ...guardedExtraction });
  assert.match(String(worker.nativeMessages.find((message) => message.id === 59)?.error), /details suppressed/);
  slowRead.resolve({ result: { value: 'page-text' } });
  await batch;

  assert.deepEqual(cdp.evaluated(), ['slow-read']);
  assert.equal(relayReply(socket, 58)?.error, 'Browser output is locked because protected-tab state is unavailable');
});

test('a parallel batch in flight when a guard appears returns no page data', async () => {
  const cdp = cdpRecorder();
  const slowRead = cdp.hold('slow-read');
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send });
  await flushWorkerTasks();
  const socket = await openRelayBesideNative(worker);

  const batch = socket.onmessage?.({
    data: JSON.stringify({ id: 60, action: 'batch', mode: 'parallel', actions: raceBatch }),
  });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 61, ...guardedExtraction });
  slowRead.resolve({ result: { value: 'synthetic-secret' } });
  await batch;

  const reply = relayReply(socket, 60);
  assert.equal(reply?.error, 'Browser output is locked while a protected secret tab is active');
  assert.equal(reply?.result, undefined);
  assert.doesNotMatch(socket.sent.join('\n'), /synthetic-secret|page:/);
});

test('a single relay read in flight when a guard appears returns neither its result nor its error', async () => {
  const cdp = cdpRecorder();
  const read = cdp.hold('slow-read');
  const failingRead = cdp.hold('slow-failing-read');
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send });
  await flushWorkerTasks();
  const socket = await openRelayBesideNative(worker);

  const inFlight = socket.onmessage?.({
    data: JSON.stringify({ id: 62, action: 'evaluateOnPage', tabId: 42, expression: 'slow-read' }),
  });
  const failing = socket.onmessage?.({
    data: JSON.stringify({ id: 63, action: 'evaluateOnPage', tabId: 42, expression: 'slow-failing-read' }),
  });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 64, ...guardedExtraction });
  read.resolve({ result: { value: 'synthetic-secret' } });
  failingRead.reject(new Error('Uncaught ReferenceError: synthetic-secret is not defined'));
  await Promise.all([inFlight, failing]);

  const lock = 'Browser output is locked while a protected secret tab is active';
  assert.deepEqual(relayReply(socket, 62), { id: 62, error: lock });
  assert.deepEqual(relayReply(socket, 63), { id: 63, error: lock });
  assert.doesNotMatch(socket.sent.join('\n'), /synthetic-secret/);
});

test('a single native read in flight when a guard appears returns neither its result nor its error', async () => {
  const cdp = cdpRecorder();
  const read = cdp.hold('slow-read');
  const failingRead = cdp.hold('slow-failing-read');
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send });
  await flushWorkerTasks();

  const inFlight = worker.nativeOnMessage.emit({ id: 65, action: 'evaluateOnPage', tabId: 42, expression: 'slow-read' });
  const failing = worker.nativeOnMessage.emit({
    id: 66,
    action: 'evaluateOnPage',
    tabId: 42,
    expression: 'slow-failing-read',
  });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 67, ...guardedExtraction });
  read.resolve({ result: { value: 'synthetic-secret' } });
  failingRead.reject(new Error('Uncaught ReferenceError: synthetic-secret is not defined'));
  await Promise.all([inFlight, failing]);

  const lock = 'Browser output is locked while a protected secret tab is active';
  assert.deepEqual(worker.nativeMessages.find((message) => message.id === 65), { id: 65, error: lock });
  assert.deepEqual(worker.nativeMessages.find((message) => message.id === 66), { id: 66, error: lock });
  assert.ok(worker.nativeMessages.find((message) => message.id === 67)?.result, 'the guarded action itself must still answer');
});

test('output read during a guard stays withheld after the guard expires, and later requests run normally', async () => {
  const cdp = cdpRecorder();
  const slowRead = cdp.hold('slow-read');
  let now = 1_000_000;
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send, now: () => now });
  await flushWorkerTasks();

  const batch = worker.nativeOnMessage.emit({ id: 70, action: 'batch', mode: 'sequential', actions: raceBatch });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 71, ...guardedExtraction, guardTtlSeconds: 1 });
  now += 1_100;
  slowRead.resolve({ result: { value: 'synthetic-secret' } });
  await batch;

  assert.deepEqual(cdp.evaluated(), ['slow-read', 'guarded-extraction']);
  assert.equal(cdp.screenshots(), 0);
  assert.deepEqual(worker.nativeMessages.find((message) => message.id === 70), {
    id: 70,
    error: 'Browser output is locked because a guarded action ran during this request',
  });

  await worker.nativeOnMessage.emit({ id: 72, action: 'batch', mode: 'sequential', actions: raceBatch.slice(2) });
  const fresh = worker.nativeMessages.find((message) => message.id === 72);
  assert.equal(fresh?.error, undefined);
  assert.equal(fresh?.result.success, true);
  assert.equal(cdp.screenshots(), 1);
});

test('a relay read in flight stays withheld when its guard is released by closing the tab', async () => {
  const cdp = cdpRecorder();
  const read = cdp.hold('slow-read');
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send });
  await flushWorkerTasks();
  const socket = await openRelayBesideNative(worker);

  const inFlight = socket.onmessage?.({
    data: JSON.stringify({ id: 73, action: 'evaluateOnPage', tabId: 43, expression: 'slow-read' }),
  });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 74, ...guardedExtraction });
  await worker.tabRemoved.emit(42);
  await socket.onmessage?.({ data: JSON.stringify({ id: 75, action: 'queryTabs' }) });
  assert.deepEqual(relayReply(socket, 75)?.result, [], 'closing the tab should have released the guard');
  read.resolve({ result: { value: 'synthetic-secret' } });
  await inFlight;

  assert.deepEqual(relayReply(socket, 73), {
    id: 73,
    error: 'Browser output is locked because a guarded action ran during this request',
  });
  assert.doesNotMatch(socket.sent.join('\n'), /synthetic-secret/);
});

test('a batch stops mid-batch when protected state becomes unavailable with no guard left', async () => {
  const cdp = cdpRecorder();
  const slowRead = cdp.hold('slow-read');
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send });
  await flushWorkerTasks();

  const batch = worker.nativeOnMessage.emit({ id: 76, action: 'batch', mode: 'sequential', actions: raceBatch });
  await flushWorkerTasks();
  await worker.nativeOnMessage.emit({ id: 77, ...guardedExtraction, tabId: 43 });
  // Releasing the guard cannot be persisted: no guard remains, but the state is unknown.
  worker.setStorageWritesFailing(true);
  await worker.tabRemoved.emit(43);
  slowRead.resolve({ result: { value: 'page-text' } });
  await batch;

  assert.deepEqual(cdp.evaluated(), ['slow-read', 'guarded-extraction']);
  assert.deepEqual(worker.nativeMessages.find((message) => message.id === 76), {
    id: 76,
    error: 'Browser output is locked because protected-tab state is unavailable',
  });
});

test('a second guarded extraction still runs while an earlier guard is active', async () => {
  const cdp = cdpRecorder();
  const worker = createWorker(new Map(), { debuggerSendCommand: cdp.send });
  await flushWorkerTasks();

  await worker.nativeOnMessage.emit({ id: 78, ...guardedExtraction });
  await worker.nativeOnMessage.emit({ id: 79, ...guardedExtraction, tabId: 43 });

  assert.ok(worker.nativeMessages.find((message) => message.id === 79)?.result);
  assert.deepEqual(cdp.evaluated(), ['guarded-extraction', 'guarded-extraction']);
});
