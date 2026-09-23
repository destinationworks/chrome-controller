/**
 * Client side of the Native Messaging IPC socket. Every transport failure is
 * an IpcError whose `kind` says whether the request could have reached the
 * host, because that decides whether a caller may replay it over the HTTP
 * relay. Used by the Pi extension (index.ts); the MCP server (mcp.ts) still
 * has its own copy of this logic.
 */

import net from 'node:net';

/**
 * Why an IPC round-trip failed. Only `unavailable` means the request never
 * reached the host; every other kind means the host received it, so the
 * command may already have run in Chrome and must not be replayed elsewhere.
 * - `unavailable`: the connection could not be opened (ENOENT, ECONNREFUSED, ...).
 * - `timeout`: the host did not answer in time -- either it is wedged or it
 *   is still waiting on a slow Chrome.
 * - `protocol`: the connection closed, reset, or returned garbage before a
 *   complete answer.
 * A host answer of `{ success: false }` is not a failure here: it is the
 * command's real result and is resolved like any other answer.
 */
export type IpcFailureKind = 'unavailable' | 'timeout' | 'protocol';

export class IpcError extends Error {
  readonly kind: IpcFailureKind;

  constructor(kind: IpcFailureKind, message: string) {
    super(message);
    this.name = 'IpcError';
    this.kind = kind;
  }
}

/** One newline-terminated JSON answer from the host. */
export type IpcResponse = {
  success?: boolean;
  result?: unknown;
  error?: string;
  [key: string]: unknown;
};

/** setTimeout clamps anything outside this range to ~1ms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function assertValidIpcTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`IPC timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} ms, got ${timeoutMs}`);
  }
}

/**
 * Sends one request line and resolves with the host's first answer line,
 * whatever its `success` value. Rejects with IpcError, or with the signal's
 * reason when `signal` aborts (before connecting, the request is never sent).
 */
export function sendIpcRequest(
  socketPath: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IpcResponse> {
  assertValidIpcTimeout(timeoutMs);
  signal?.throwIfAborted();
  // Serialize before connecting so a bad payload rejects instead of throwing
  // from inside the connect callback.
  const line = JSON.stringify(payload) + '\n';

  return new Promise((resolve, reject) => {
    let connected = false;
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      outcome();
    };
    const fail = (error: Error) => settle(() => {
      client.destroy();
      reject(error);
    });
    const onAbort = () => fail(signal!.reason as Error);

    // `{ path }` rather than a bare string: net.connect treats a numeric
    // string as a TCP port.
    const client = net.connect({ path: socketPath }, () => {
      connected = true;
      client.write(line);
    });
    // Decode as a stream: a multi-byte character split across two reads
    // would otherwise be turned into replacement characters.
    client.setEncoding('utf8');
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => fail(new IpcError('timeout', `did not answer within ${timeoutMs}ms`)), timeoutMs);

    // Look for the newline only in each new chunk: rescanning the whole
    // buffer is quadratic, and a multi-megabyte answer (video frames) would
    // then take long enough to be reported as a wedged host.
    const chunks: string[] = [];
    client.on('data', (chunk: string) => {
      const newline = chunk.indexOf('\n');
      if (newline < 0) {
        chunks.push(chunk);
        return;
      }
      chunks.push(chunk.slice(0, newline));
      let parsed: unknown;
      try {
        parsed = JSON.parse(chunks.join(''));
      } catch {
        fail(new IpcError('protocol', 'returned an unparseable response'));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(new IpcError('protocol', 'returned a response that is not a JSON object'));
        return;
      }
      settle(() => {
        client.end();
        resolve(parsed as IpcResponse);
      });
    });

    client.on('error', (err) => {
      if (connected) fail(new IpcError('protocol', `connection failed after the request was sent (${err.message})`));
      else fail(new IpcError('unavailable', err.message));
    });

    // Without this, a host that exits mid-request leaves the client waiting
    // out the full timeout and then blaming a wedge.
    client.on('close', () => fail(new IpcError('protocol', 'closed the connection without answering')));
  });
}

/**
 * Turns a raw IPC failure into the message an operator or agent acts on.
 * `relayHint` names the settings that enable relay fallback for the caller.
 */
export function describeIpcFailure(error: IpcError, socketPath: string, relayHint: string): IpcError {
  const notRetried = 'The command may still have run in Chrome, so it was not retried.';
  switch (error.kind) {
    case 'unavailable':
      return new IpcError('unavailable',
        `NATIVE_IPC_UNAVAILABLE: Native Messaging IPC at ${socketPath} is unavailable (${error.message}). ` +
        `Zero-ports Native Messaging is the primary protocol. Fallback to network relay requires explicit activation (${relayHint}).`);
    case 'timeout':
      return new IpcError('timeout',
        `NATIVE_IPC_TIMEOUT: Native host at ${socketPath} accepted the request but ${error.message}. ` +
        `Either the host is wedged or it is still waiting on a slow Chrome. Run \`npm run watchdog\` to tell them apart: ` +
        `it probes with hostPing, which the host answers locally without Chrome. ${notRetried}`);
    case 'protocol':
      return new IpcError('protocol',
        `NATIVE_IPC_PROTOCOL_ERROR: Native host at ${socketPath} ${error.message}. ` +
        `Run \`npm run watchdog\` to check whether the host is still alive. ${notRetried}`);
  }
}
