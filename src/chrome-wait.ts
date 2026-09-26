/**
 * Timeout budget for one browser request, shared by the native host (which
 * waits on Chrome) and its IPC clients (which wait on the host).
 *
 * Three clocks run for every request, and they must stay ordered:
 *
 *   extension's own work  <  host's wait for Chrome  <  client's wait for the host
 *
 * - A host wait shorter than the work the extension was asked to do (a 20 s
 *   recording, a 2 s console-collection window) reports a timeout while Chrome
 *   is working exactly as asked.
 * - A client wait shorter than the host's gives up with an ambiguous IPC
 *   timeout ("wedged host or slow Chrome?") while a healthy host is about to
 *   deliver its definitive answer.
 *
 * The host and both clients derive their timeouts from this module, so the
 * ordering holds by construction rather than by keeping constants in step.
 */

type Params = Record<string, unknown>;

/** The host's wait for one ordinary Chrome round trip, and the slack added on
 *  top of an action's own working time. */
export const DEFAULT_CHROME_WAIT_MS = 15000;

/** The longest wait for Chrome the host accepts. The relay uses the same cap. */
export const MAX_CHROME_WAIT_MS = 120000;

/**
 * How much longer an IPC client waits than the host's own deadline. Covers the
 * request's delivery before the host starts its clock and the transfer of the
 * host's answer after it fires. A client timeout therefore means the host
 * missed its own deadline, which a host whose event loop is turning never does.
 */
export const IPC_CLIENT_MARGIN_MS = 2000;

/** The client's wait for an answer the host gives by itself, without Chrome
 *  (hostPing). A Chrome budget does not apply; this matches the watchdog's probe. */
export const HOST_LOCAL_WAIT_MS = 3000;

/** The host's wait for Chrome during a health check, so a silent Chrome is
 *  reported well before an ordinary command would give up on it. */
export const HEALTH_CHROME_WAIT_MS = 8000;

const HOST_LOCAL_ACTIONS = new Set(['hostPing']);

// Allowances for latency that Chrome does not bound, per unit of work. Measured
// through the native host on a live Chrome: Page.captureScreenshot took
// 283-548 ms per video frame, an animated keystroke 126-131 ms beyond its
// sleeps, an ordinary action 345-467 ms. Each allowance is about twice the
// worst case seen, because underestimating wastes the whole action while
// overestimating only delays the report of a real failure.
export const FRAME_CAPTURE_ALLOWANCE_MS = 1000;
export const KEYSTROKE_ALLOWANCE_MS = 300;
export const BATCH_ITEM_ALLOWANCE_MS = 1000;

const GUARDED_ACTIONS = new Set(['extractSecretGuarded', 'injectSecretGuarded']);

function isRecord(value: unknown): value is Params {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Work that the extension's arithmetic turns into NaN or a negative number
 *  does not happen: its loops do not run and its timers fire at once. */
function work(ms: number): number {
  return Number.isNaN(ms) ? 0 : Math.max(0, ms);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Time the extension spends on an action before it can answer, beyond one
 * ordinary round trip. Mirrors the defaults and loops in
 * `Chrome Extension/background.js`; extension-background.test.ts runs the real
 * worker on a virtual clock to hold the two together.
 *
 * `worst` bounds what the action may take, with an allowance for Chrome's
 * latency on every unit of work. `least` is what its own sleeps and windows
 * take even if Chrome answered instantly: an action whose least time is past
 * the cap cannot finish however long anyone waits.
 */
function workMs(action: string, params: Params, bound: 'worst' | 'least'): number {
  const worst = bound === 'worst';

  if (action === 'captureVideo') {
    const fps = Number(params.fps) || 5;
    const duration = Number(params.duration) || 3;
    const frames = Math.round(duration * fps);
    if (!(frames > 0)) return 0;
    // An endless frame count loops forever in the extension.
    if (!Number.isFinite(frames)) return Infinity;
    const intervalMs = work(Math.round(1000 / fps));
    // The extension sleeps between frames, not after the last one.
    return worst ? frames * (intervalMs + FRAME_CAPTURE_ALLOWANCE_MS) : work((frames - 1) * intervalMs);
  }

  if (action === 'getConsoleLogs') {
    return work(Number(params.timeoutMs || 2000));
  }

  if (action === 'sendCommand') {
    const command = isRecord(params.commandParams) ? params.commandParams : {};
    if (params.method !== 'Input.insertText' || command.animateTyping !== true) return 0;
    const keystrokes = Array.from(String(command.text || '')).length;
    const delayMs = work(clamp(Number(command.typingDelayMs || 65), 12, 240));
    if (!worst) return keystrokes * delayMs;
    const jitterMs = work(clamp(Number(command.typingJitterMs || 24), 0, 80));
    // Upper bound: full jitter on every key, and every key a pause key.
    const perKeyMs = delayMs + jitterMs + Math.round(delayMs * 0.65) + KEYSTROKE_ALLOWANCE_MS;
    return keystrokes * perKeyMs;
  }

  if (action === 'batch') {
    const items = params.actions || params.commands;
    if (!Array.isArray(items)) return 0;
    // The worst case sums items even in parallel mode: parallel items still
    // share one browser, and a sum can only overestimate. The least a parallel
    // batch takes is its longest item. The extension rejects nested batches,
    // so they add no work of their own. An item with an explicit wait may take
    // that long, as it would over the relay, which waits on each item; the wait
    // never shortens the item's own work.
    const itemMs = items.map((item) => {
      if (!isRecord(item) || typeof item.action !== 'string' || item.action === 'batch') {
        return worst ? BATCH_ITEM_ALLOWANCE_MS : 0;
      }
      const ownMs = workMs(item.action, item, bound);
      if (!worst) return ownMs;
      const explicit = explicitWait(item.action, item);
      const waitMs = typeof explicit === 'number' && Number.isFinite(explicit) ? work(explicit) : 0;
      return BATCH_ITEM_ALLOWANCE_MS + Math.max(ownMs, waitMs);
    });
    if (!worst && params.mode !== 'sequential') return Math.max(0, ...itemMs);
    return itemMs.reduce((sum, ms) => sum + ms, 0);
  }

  return 0;
}

/** The most time the extension may spend on an action: see workMs. */
export function chromeWorkMs(action: string, params: Params): number {
  return workMs(action, params, 'worst');
}

/** The wait the caller set explicitly, if any. `requestTimeoutMs` wins, as on
 *  the relay. On getConsoleLogs `timeoutMs` is the extension's collection
 *  window, not a wait, so it never counts. */
function explicitWait(action: string, params: Params): unknown {
  return params.requestTimeoutMs ?? (action === 'getConsoleLogs' ? undefined : params.timeoutMs);
}

/**
 * The host's wait for Chrome's answer to one request: the caller's explicit
 * wait, otherwise one ordinary round trip plus the action's own working time,
 * capped at the maximum. Throws for an explicit wait the host does not accept,
 * and for an action that cannot finish within the maximum however fast Chrome is.
 */
export function chromeWaitMs(action: string, params: Params): number {
  const explicit = explicitWait(action, params);
  if (explicit === undefined) {
    const leastMs = workMs(action, params, 'least');
    if (leastMs >= MAX_CHROME_WAIT_MS) {
      // Fail now rather than wait out the cap while the extension keeps
      // working: typing cut off at the cap and retried would type twice.
      throw new Error(
        `${action} needs at least ${leastMs}ms of Chrome time, beyond the ${MAX_CHROME_WAIT_MS}ms limit for one request; split it into shorter requests`,
      );
    }
    // Rounded up: fractional inputs (a 50.5 ms typing delay) must still yield
    // a wait the host and the relay accept, and they accept only integers.
    return Math.min(MAX_CHROME_WAIT_MS, Math.ceil(DEFAULT_CHROME_WAIT_MS + chromeWorkMs(action, params)));
  }
  if (typeof explicit !== 'number' || !Number.isSafeInteger(explicit) || explicit < 1 || explicit > MAX_CHROME_WAIT_MS) {
    throw new Error(`Native Messaging request timeout must be an integer from 1 to ${MAX_CHROME_WAIT_MS} milliseconds`);
  }
  return explicit;
}

/**
 * The request as it should go on the wire. An action with working time of its
 * own carries its wait as `requestTimeoutMs`, so the relay, whose default wait
 * is shorter and which knows nothing of the action, budgets it as the host does.
 * Other requests are sent unchanged.
 */
export function withChromeWait(action: string, params: Params): Params {
  if (explicitWait(action, params) !== undefined) return params;
  // getConsoleLogs is always stamped: without a wait, the relay would read its
  // collection window as one, and reject a zero or non-numeric window.
  if (action !== 'getConsoleLogs' && chromeWorkMs(action, params) === 0) return params;
  const sent: Params = { ...params, requestTimeoutMs: chromeWaitMs(action, params) };
  if (action === 'batch') {
    // The relay splits a batch and waits on each item separately, so each item
    // with work of its own carries its own wait as well.
    const key = params.actions ? 'actions' : 'commands';
    const items = params[key];
    if (Array.isArray(items)) {
      sent[key] = items.map((item) => (
        isRecord(item) && typeof item.action === 'string' && item.action !== 'batch'
          ? withChromeWait(item.action, item)
          : item
      ));
    }
  }
  return sent;
}

/**
 * How long an IPC client waits for the host: the host's own deadline for this
 * request plus the delivery margin. hostPing, which the host answers without
 * Chrome, gets the short local wait instead. A guarded secret action takes up to two
 * Chrome round trips at the ordinary wait, whatever the request says: the page
 * action, then closing the tab when it fails. A wait the host will reject is
 * answered at once, so the ordinary deadline is ample for it.
 */
export function ipcClientTimeoutMs(action: string, params: Params): number {
  if (HOST_LOCAL_ACTIONS.has(action)) return HOST_LOCAL_WAIT_MS;
  let hostDeadlineMs: number;
  if (GUARDED_ACTIONS.has(action)) {
    hostDeadlineMs = 2 * DEFAULT_CHROME_WAIT_MS;
  } else {
    try {
      hostDeadlineMs = chromeWaitMs(action, params);
    } catch {
      hostDeadlineMs = DEFAULT_CHROME_WAIT_MS;
    }
  }
  return hostDeadlineMs + IPC_CLIENT_MARGIN_MS;
}
