/**
 * Unit tests for the shared request timeout budget (src/chrome-wait.ts).
 *
 * Run: npx tsx --test src/chrome-wait.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_ITEM_ALLOWANCE_MS,
  DEFAULT_CHROME_WAIT_MS,
  FRAME_CAPTURE_ALLOWANCE_MS,
  HOST_LOCAL_WAIT_MS,
  IPC_CLIENT_MARGIN_MS,
  KEYSTROKE_ALLOWANCE_MS,
  MAX_CHROME_WAIT_MS,
  chromeWaitMs,
  chromeWorkMs,
  ipcClientTimeoutMs,
  withChromeWait,
} from './chrome-wait.js';

const TYPED = 'The quick brown fox, jumps over the lazy dog. Again!';

function typing(text: string, extra: Record<string, unknown> = {}) {
  return {
    tabId: 1,
    method: 'Input.insertText',
    commandParams: { text, animateTyping: true, sound: false, ...extra },
  };
}

// Requests the tools actually send, plus the edge shapes a caller can produce.
const REQUESTS: [string, Record<string, unknown>][] = [
  ['queryTabs', {}],
  ['queryTabs', { timeoutMs: 8000 }],
  ['evaluateOnPage', { tabId: 1, expression: '1' }],
  ['captureVideo', { tabId: 1 }],
  ['captureVideo', { tabId: 1, fps: 30, duration: 2 }],
  ['captureVideo', { tabId: 1, fps: 30, duration: 4 }],
  ['captureVideo', { tabId: 1, fps: 'fast', duration: -4 }],
  ['getConsoleLogs', { tabId: 1 }],
  ['getConsoleLogs', { tabId: 1, timeoutMs: 2000.5 }],
  ['getConsoleLogs', { tabId: 1, timeoutMs: 119999 }],
  ['sendCommand', typing(TYPED, { typingDelayMs: 50.5 })],
  ['batch', { mode: 'sequential', actions: [{ action: 'ensureDebugger', tabId: 1 }, { action: 'sendCommand', ...typing(TYPED) }] }],
  ['batch', { actions: Array.from({ length: 500 }, () => ({ action: 'captureScreenshot', tabId: 1 })) }],
];

test('for every request the IPC client outlasts the host, and the host covers the work', () => {
  for (const [action, params] of REQUESTS) {
    const label = `${action} ${JSON.stringify(params).slice(0, 80)}`;
    const wait = chromeWaitMs(action, params);
    assert.ok(Number.isSafeInteger(wait) && wait >= 1 && wait <= MAX_CHROME_WAIT_MS, `${label}: host accepts wait ${wait}`);
    assert.ok(ipcClientTimeoutMs(action, params) >= wait + IPC_CLIENT_MARGIN_MS, `${label}: client outlasts host`);
    const work = chromeWorkMs(action, params);
    assert.ok(!Number.isNaN(work) && work >= 0, `${label}: work ${work} is a duration`);
    if (params.timeoutMs === undefined || action === 'getConsoleLogs') {
      assert.ok(wait >= Math.min(MAX_CHROME_WAIT_MS, work), `${label}: wait ${wait} covers work ${work}`);
    }
  }
});

test('an ordinary command keeps the ordinary wait and goes on the wire unchanged', () => {
  const params = { tabId: 1, selector: '#go' };
  assert.equal(chromeWorkMs('clickSelector', params), 0);
  assert.equal(chromeWaitMs('clickSelector', params), DEFAULT_CHROME_WAIT_MS);
  assert.equal(ipcClientTimeoutMs('clickSelector', params), DEFAULT_CHROME_WAIT_MS + IPC_CLIENT_MARGIN_MS);
  assert.equal(withChromeWait('clickSelector', params), params, 'no requestTimeoutMs is added, so the relay keeps its own default');
});

test('an explicit wait wins: requestTimeoutMs first, then timeoutMs', () => {
  assert.equal(chromeWaitMs('queryTabs', { timeoutMs: 8000 }), 8000);
  assert.equal(chromeWaitMs('queryTabs', { timeoutMs: 8000, requestTimeoutMs: 5000 }), 5000);
  // A caller that asks for less than the action needs gets what it asked for.
  assert.equal(chromeWaitMs('captureVideo', { tabId: 1, duration: 60, timeoutMs: 4000 }), 4000);
  assert.equal(ipcClientTimeoutMs('queryTabs', { requestTimeoutMs: 5000 }), 5000 + IPC_CLIENT_MARGIN_MS);
});

test('getConsoleLogs timeoutMs is the collection window, never the wait', () => {
  assert.equal(chromeWorkMs('getConsoleLogs', { tabId: 1, timeoutMs: 3000 }), 3000);
  assert.equal(chromeWaitMs('getConsoleLogs', { tabId: 1, timeoutMs: 3000 }), DEFAULT_CHROME_WAIT_MS + 3000);
  // The extension's default window when none is given.
  assert.equal(chromeWaitMs('getConsoleLogs', { tabId: 1 }), DEFAULT_CHROME_WAIT_MS + 2000);
  // requestTimeoutMs is still the caller's explicit wait.
  assert.equal(chromeWaitMs('getConsoleLogs', { tabId: 1, timeoutMs: 3000, requestTimeoutMs: 9000 }), 9000);
});

test('an explicit wait the host would refuse throws its message; the client falls back to the ordinary deadline', () => {
  for (const bad of ['15000', 0, -1, 1.5, MAX_CHROME_WAIT_MS + 1, null, Number.NaN]) {
    assert.throws(
      () => chromeWaitMs('queryTabs', { timeoutMs: bad }),
      /^Error: Native Messaging request timeout must be an integer from 1 to 120000 milliseconds$/,
      `timeoutMs ${String(bad)}`,
    );
    if (bad !== null) assert.throws(() => chromeWaitMs('queryTabs', { requestTimeoutMs: bad }), /must be an integer/);
    // The host rejects it at once, so the client need not wait any longer than usual.
    assert.equal(ipcClientTimeoutMs('queryTabs', { timeoutMs: bad }), DEFAULT_CHROME_WAIT_MS + IPC_CLIENT_MARGIN_MS);
  }
  // A null requestTimeoutMs is absent, exactly as on the relay's `??` chain.
  assert.equal(chromeWaitMs('queryTabs', { requestTimeoutMs: null, timeoutMs: 8000 }), 8000);
  assert.equal(chromeWaitMs('queryTabs', { timeoutMs: 1 }), 1);
  assert.equal(chromeWaitMs('queryTabs', { timeoutMs: MAX_CHROME_WAIT_MS }), MAX_CHROME_WAIT_MS);
});

test('captureVideo budgets every frame, from the extension defaults when none are given', () => {
  // Extension defaults: 5 fps for 3 s is 15 frames, 200 ms apart.
  assert.equal(chromeWorkMs('captureVideo', { tabId: 1 }), 15 * (200 + FRAME_CAPTURE_ALLOWANCE_MS));
  assert.equal(chromeWorkMs('captureVideo', { tabId: 1, fps: 10, duration: 3 }), 30 * (100 + FRAME_CAPTURE_ALLOWANCE_MS));
  // Junk the extension replaces with its defaults.
  assert.equal(chromeWorkMs('captureVideo', { tabId: 1, fps: 'x', duration: 0 }), chromeWorkMs('captureVideo', { tabId: 1 }));
  // Negative frame counts never run a loop in the extension.
  assert.equal(chromeWorkMs('captureVideo', { tabId: 1, fps: 5, duration: -3 }), 0);
  assert.equal(chromeWorkMs('captureVideo', { tabId: 1, fps: -5, duration: 3 }), 0);
  // A vanishing frame rate yields no frames rather than 0 x Infinity = NaN.
  assert.equal(chromeWorkMs('captureVideo', { tabId: 1, fps: 5e-324, duration: 3 }), 0);
  // 120 frames could need 139 s in the worst case but need only 4 s of sleeps:
  // possible, so it gets the whole cap rather than a refusal.
  assert.equal(chromeWaitMs('captureVideo', { tabId: 1, fps: 30, duration: 4 }), MAX_CHROME_WAIT_MS);
});

test('an action that cannot finish within the cap however fast Chrome is fails at once', () => {
  const impossible: [string, Record<string, unknown>][] = [
    ['captureVideo', { tabId: 1, fps: Infinity }], // the extension would loop forever
    ['captureVideo', { tabId: 1, fps: 60, duration: 600 }], // 36 000 frames, 612 s of sleeps
    ['getConsoleLogs', { tabId: 1, timeoutMs: 1e9 }],
    ['getConsoleLogs', { tabId: 1, timeoutMs: MAX_CHROME_WAIT_MS }], // would race the cap exactly
    ['sendCommand', typing('x'.repeat(500), { typingDelayMs: 240 })], // 120 s of delays alone
    ['batch', { mode: 'sequential', actions: [{ action: 'getConsoleLogs', timeoutMs: 70000 }, { action: 'getConsoleLogs', timeoutMs: 70000 }] }],
  ];
  for (const [action, params] of impossible) {
    const label = `${action} ${JSON.stringify(params).slice(0, 60)}`;
    assert.throws(() => chromeWaitMs(action, params), /needs at least \d+|Infinity/, label);
    assert.throws(() => chromeWaitMs(action, params), /beyond the 120000ms limit for one request; split it/, label);
    // The client refuses it before sending anything...
    assert.throws(() => withChromeWait(action, params), /beyond the 120000ms limit/, label);
    // ...and a raw IPC caller gets the host's immediate refusal, so the client
    // needs no more than the ordinary deadline.
    assert.equal(ipcClientTimeoutMs(action, params), DEFAULT_CHROME_WAIT_MS + IPC_CLIENT_MARGIN_MS, label);
  }
  // Just inside the cap stays possible, with whatever wait is left.
  assert.equal(chromeWaitMs('getConsoleLogs', { tabId: 1, timeoutMs: MAX_CHROME_WAIT_MS - 1 }), MAX_CHROME_WAIT_MS);
  assert.equal(chromeWaitMs('sendCommand', typing('x'.repeat(499), { typingDelayMs: 240 })), MAX_CHROME_WAIT_MS);
  // In parallel, two 70 s windows run side by side: 70 s at least, so possible.
  assert.equal(
    chromeWaitMs('batch', { mode: 'parallel', actions: [{ action: 'getConsoleLogs', timeoutMs: 70000 }, { action: 'getConsoleLogs', timeoutMs: 70000 }] }),
    MAX_CHROME_WAIT_MS,
  );
  // An explicit wait is the caller's choice and is not second-guessed.
  assert.equal(chromeWaitMs('getConsoleLogs', { tabId: 1, timeoutMs: 1e9, requestTimeoutMs: 5000 }), 5000);
});

test('the budget covers every duration measured on a live Chrome, before the ordinary slack', () => {
  // Measured through the native host against a live Chrome (see the 2026-09-23
  // learning on the IPC client giving up before the host).
  const measured: [string, Record<string, unknown>, number][] = [
    ['captureVideo', { tabId: 1 }, 8150],
    ['captureVideo', { tabId: 1, fps: 5, duration: 3, format: 'png' }, 11016],
    ['captureVideo', { tabId: 1, fps: 10, duration: 3 }, 11406],
    ['captureVideo', { tabId: 1, fps: 30, duration: 2 }, 21968],
    ['getConsoleLogs', { tabId: 1, timeoutMs: 2000 }, 2007],
    ['sendCommand', typing(TYPED, { typingDelayMs: 50 }), 10423],
    ['sendCommand', typing(TYPED, { typingDelayMs: 12 }), 7902],
  ];
  for (const [action, params, chromeMs] of measured) {
    const work = chromeWorkMs(action, params);
    // getConsoleLogs finished 7 ms after its window: attach and Runtime.enable
    // are an ordinary round trip, which the default wait on top covers.
    const covered = action === 'getConsoleLogs' ? chromeWaitMs(action, params) : work;
    assert.ok(covered >= chromeMs, `${action} ${JSON.stringify(params).slice(0, 60)}: ${covered} < measured ${chromeMs}`);
  }
});

test('animated typing budgets every keystroke at its worst case', () => {
  // 65 ms default delay, 24 ms default jitter, and a pause of 0.65 x delay.
  assert.equal(chromeWorkMs('sendCommand', typing('ab')), 2 * (65 + 24 + 42 + KEYSTROKE_ALLOWANCE_MS));
  // The extension clamps the delay to 12..240 ms and the jitter to 0..80 ms.
  assert.equal(chromeWorkMs('sendCommand', typing('a', { typingDelayMs: 1, typingJitterMs: 500 })), 12 + 80 + 8 + KEYSTROKE_ALLOWANCE_MS);
  assert.equal(chromeWorkMs('sendCommand', typing('a', { typingDelayMs: 9999 })), 240 + 24 + 156 + KEYSTROKE_ALLOWANCE_MS);
  // A non-numeric delay makes the extension's sleeps fire at once.
  assert.equal(chromeWorkMs('sendCommand', typing('a', { typingDelayMs: 'slow' })), 24 + KEYSTROKE_ALLOWANCE_MS);
  // Keystrokes are code points, as in the extension's Array.from(text).
  assert.equal(chromeWorkMs('sendCommand', typing('👍👍')), chromeWorkMs('sendCommand', typing('ab')));
  // Instant insertion and other CDP commands are ordinary round trips.
  assert.equal(chromeWorkMs('sendCommand', { ...typing(TYPED), commandParams: { text: TYPED, animateTyping: false } }), 0);
  assert.equal(chromeWorkMs('sendCommand', { tabId: 1, method: 'Input.dispatchMouseEvent', commandParams: { type: 'mouseMoved' } }), 0);
  assert.equal(chromeWorkMs('sendCommand', { tabId: 1, method: 'Input.insertText' }), 0);
});

test('a fractional input still yields a wait the host and the relay accept', () => {
  const wait = chromeWaitMs('sendCommand', typing(TYPED, { typingDelayMs: 50.5 }));
  assert.ok(Number.isSafeInteger(wait), `wait ${wait} must be an integer`);
  assert.equal(chromeWaitMs('getConsoleLogs', { tabId: 1, timeoutMs: 2000.5 }), DEFAULT_CHROME_WAIT_MS + 2001);
});

test('a batch budgets each item on top of its own work', () => {
  const typeText = [{ action: 'ensureDebugger', tabId: 1 }, { action: 'sendCommand', ...typing(TYPED) }];
  assert.equal(
    chromeWorkMs('batch', { mode: 'sequential', actions: typeText }),
    2 * BATCH_ITEM_ALLOWANCE_MS + chromeWorkMs('sendCommand', typing(TYPED)),
  );
  // Parallel items share one browser, so they are summed as well.
  const captures = [{ action: 'captureVideo', tabId: 1 }, { action: 'captureVideo', tabId: 2 }];
  assert.equal(chromeWorkMs('batch', { mode: 'parallel', actions: captures }), 2 * (BATCH_ITEM_ALLOWANCE_MS + chromeWorkMs('captureVideo', { tabId: 1 })));
  // The extension's `commands` alias.
  assert.equal(chromeWorkMs('batch', { commands: captures }), chromeWorkMs('batch', { actions: captures }));
  // Items the extension rejects cost no work of their own; nesting is not followed.
  assert.equal(chromeWorkMs('batch', { actions: [null, 'x', { action: 'batch', actions: captures }] }), 3 * BATCH_ITEM_ALLOWANCE_MS);
  assert.equal(chromeWorkMs('batch', { actions: 'not-a-list' }), 0);
  assert.equal(chromeWorkMs('batch', {}), 0);
});

test('a batch item with an explicit wait may take that long, as the relay would let it', () => {
  const slow = { action: 'queryTabs', requestTimeoutMs: 100000 };
  assert.equal(chromeWorkMs('batch', { actions: [slow] }), BATCH_ITEM_ALLOWANCE_MS + 100000);
  // timeoutMs is a wait everywhere except getConsoleLogs, where it stays the window.
  assert.equal(chromeWorkMs('batch', { actions: [{ action: 'queryTabs', timeoutMs: 30000 }] }), BATCH_ITEM_ALLOWANCE_MS + 30000);
  assert.equal(
    chromeWorkMs('batch', { actions: [{ action: 'getConsoleLogs', timeoutMs: 3000 }] }),
    BATCH_ITEM_ALLOWANCE_MS + 3000,
  );
  // Over IPC the host then waits for it rather than giving up at 16 s.
  assert.equal(chromeWaitMs('batch', { actions: [slow] }), DEFAULT_CHROME_WAIT_MS + BATCH_ITEM_ALLOWANCE_MS + 100000);
  // A short explicit wait never shortens an item's own work.
  const capture = { action: 'captureVideo', tabId: 1, requestTimeoutMs: 4000 };
  assert.equal(chromeWorkMs('batch', { actions: [capture] }), BATCH_ITEM_ALLOWANCE_MS + chromeWorkMs('captureVideo', capture));
  // An explicit wait only lengthens the worst case; it adds nothing to the least.
  assert.equal(chromeWaitMs('batch', { mode: 'sequential', actions: [slow, slow] }), MAX_CHROME_WAIT_MS);
});

test('hostPing, which the host answers without Chrome, gets the short local wait', () => {
  assert.equal(ipcClientTimeoutMs('hostPing', {}), HOST_LOCAL_WAIT_MS);
  // Whatever the request says: the host never forwards it to Chrome.
  assert.equal(ipcClientTimeoutMs('hostPing', { requestTimeoutMs: 60000 }), HOST_LOCAL_WAIT_MS);
});

test('a guarded secret action gives the host two ordinary round trips whatever the request says', () => {
  for (const action of ['extractSecretGuarded', 'injectSecretGuarded']) {
    assert.equal(ipcClientTimeoutMs(action, { tabId: 1 }), 2 * DEFAULT_CHROME_WAIT_MS + IPC_CLIENT_MARGIN_MS);
    assert.equal(ipcClientTimeoutMs(action, { tabId: 1, timeoutMs: 1 }), 2 * DEFAULT_CHROME_WAIT_MS + IPC_CLIENT_MARGIN_MS);
  }
});

test('withChromeWait pins the wait only for actions with work of their own, without mutating the request', () => {
  const capture = { tabId: 1, fps: 10, duration: 3 };
  const sent = withChromeWait('captureVideo', capture);
  assert.deepEqual(sent, { ...capture, requestTimeoutMs: chromeWaitMs('captureVideo', capture) });
  assert.deepEqual(capture, { tabId: 1, fps: 10, duration: 3 }, 'caller object untouched');

  const logs = { tabId: 1, timeoutMs: 2000 };
  assert.deepEqual(withChromeWait('getConsoleLogs', logs), { tabId: 1, timeoutMs: 2000, requestTimeoutMs: DEFAULT_CHROME_WAIT_MS + 2000 });

  // An explicit wait is left alone.
  const explicit = { tabId: 1, requestTimeoutMs: 4000 };
  assert.equal(withChromeWait('captureVideo', explicit), explicit);
  const legacy = { tabId: 1, timeoutMs: 60000 };
  assert.equal(withChromeWait('captureVideo', legacy), legacy);

  // getConsoleLogs is pinned even with no window, which the relay would otherwise
  // read as its wait and refuse.
  // (A zero window falls back to the extension's 2 s default; a non-numeric one collects nothing.)
  assert.deepEqual(withChromeWait('getConsoleLogs', { tabId: 1, timeoutMs: 0 }), { tabId: 1, timeoutMs: 0, requestTimeoutMs: DEFAULT_CHROME_WAIT_MS + 2000 });
  assert.deepEqual(withChromeWait('getConsoleLogs', { tabId: 1, timeoutMs: 'soon' }), { tabId: 1, timeoutMs: 'soon', requestTimeoutMs: DEFAULT_CHROME_WAIT_MS });

  // Whatever is pinned is valid for the relay, whose cap is the host's.
  const long = withChromeWait('captureVideo', { tabId: 1, fps: 30, duration: 4 });
  assert.equal(long.requestTimeoutMs, 120000);
});

test('withChromeWait gives each batch item with work its own wait, because the relay waits per item', () => {
  const items = [
    { action: 'getConsoleLogs', tabId: 1, timeoutMs: 300 },
    { action: 'queryTabs' },
    { action: 'captureVideo', tabId: 1, requestTimeoutMs: 4000 },
    { action: 'batch', actions: [{ action: 'getConsoleLogs' }] },
    'not-an-item',
  ];
  for (const key of ['actions', 'commands']) {
    const sent = withChromeWait('batch', { mode: 'sequential', [key]: items });
    assert.deepEqual(sent[key], [
      { action: 'getConsoleLogs', tabId: 1, timeoutMs: 300, requestTimeoutMs: 15300 },
      { action: 'queryTabs' }, // ordinary: the relay's own default applies
      { action: 'captureVideo', tabId: 1, requestTimeoutMs: 4000 }, // explicit: kept
      { action: 'batch', actions: [{ action: 'getConsoleLogs' }] }, // nested: rejected by the extension anyway
      'not-an-item',
    ], key);
    // 15 s + 5 items x 1000 ms + the 300 ms window + the capture's 18 s of
    // frames: an item's own explicit wait does not shorten the batch's work.
    assert.equal(sent.requestTimeoutMs, 38300, key);
  }
  assert.equal(items[0].requestTimeoutMs, undefined, 'caller items untouched');
});

test('a batch of ordinary items gets a concrete per-item allowance', () => {
  // 40 screenshots at the ~450 ms measured for one ordinary action need ~18 s,
  // more than one ordinary 15 s round trip.
  const screenshots = Array.from({ length: 40 }, () => ({ action: 'captureScreenshot', tabId: 1 }));
  assert.equal(chromeWaitMs('batch', { mode: 'sequential', actions: screenshots }), 55000);
});
