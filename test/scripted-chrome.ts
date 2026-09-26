/**
 * A real NativeMessagingHost on a private socket, with Chrome replaced by a
 * script: every request the host forwards is queued, and Chrome answers only
 * when a test says so. Lets a test drive the host's own timers (and the IPC
 * client's) against a Chrome that is slow, silent, or answers at a chosen time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeMessagingHost, type NativeMessage } from '../src/native-host.ts';

export interface ScriptedChrome {
  socketPath: string;
  host: NativeMessagingHost;
  /** Resolves with the next request the host forwards to Chrome. */
  nextRequest(): Promise<NativeMessage>;
  /** Answers a forwarded request the way the extension would. */
  answer(id: number | undefined, result: unknown): void;
  close(): void;
}

export async function startScriptedChrome(prefix: string): Promise<ScriptedChrome> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const socketPath = path.join(dir, 'run.sock');
  const host = new NativeMessagingHost(socketPath);
  await host.ready;

  const queued: NativeMessage[] = [];
  const waiting: ((request: NativeMessage) => void)[] = [];
  host.sendToChrome = (payload) => {
    const waiter = waiting.shift();
    if (waiter) waiter(payload);
    else queued.push(payload);
  };
  const receive = (host as unknown as { handleMessageFromChrome(message: NativeMessage): void })
    .handleMessageFromChrome.bind(host);

  return {
    socketPath,
    host,
    nextRequest: () => {
      const request = queued.shift();
      return request ? Promise.resolve(request) : new Promise((resolve) => waiting.push(resolve));
    },
    answer: (id, result) => receive({ id, result }),
    close: () => {
      host.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Sets (or, for `undefined`, deletes) environment variables; returns the undo. */
export function setEnv(values: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (next: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  return () => apply(saved);
}

/**
 * A stand-in host socket that answers every request at once with one JSON line
 * carrying `resultBytes` of payload: a large answer, as a png capture of a real
 * page produces. Returns the socket path and a cleanup.
 */
export async function startLargeAnswerHost(prefix: string, resultBytes: number): Promise<{ socketPath: string; close(): void }> {
  const net = await import('node:net');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const socketPath = path.join(dir, 'run.sock');
  const line = JSON.stringify({ success: true, result: { data: 'x'.repeat(resultBytes) } }) + '\n';
  const server = net.createServer((client) => {
    client.once('data', () => client.end(line));
    client.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return {
    socketPath,
    close: () => {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
