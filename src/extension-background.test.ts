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
      async sendMessage(tabId: number, message: Record<string, unknown>) {
        return options.tabsSendMessage ? options.tabsSendMessage(tabId, message) : {};
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
    debuggerOnEvent,
    debuggerSendCalls: () => debuggerSendCalls,
    chromeTouches: () => [...chromeTouches],
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
