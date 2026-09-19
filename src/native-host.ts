import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildGuardedExtractionExpression,
  buildGuardedInjectionExpression,
} from './secure-extraction.js';
import { normalizeInstanceName, readDiscovery } from './discovery.js';

export function getSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\chrome-controller-ipc';
  }
  if (process.env.CHROME_CONTROLLER_SOCKET) {
    return process.env.CHROME_CONTROLLER_SOCKET;
  }
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'chrome-controller', 'run.sock');
  }
  return path.join(os.homedir(), '.chrome-controller', 'run', 'chrome-controller.sock');
}

export const SOCKET_PATH = getSocketPath();

export function ensureSocketDir(socketPath: string): void {
  if (process.platform !== 'win32') {
    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stats = fs.lstatSync(dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Native Host socket directory must be a real directory: ${dir}`);
    }
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
      throw new Error(`Native Host socket directory is not owned by the current user: ${dir}`);
    }
    fs.chmodSync(dir, 0o700);
  }
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

function removeSocketIfOwned(socketPath: string, identity: SocketIdentity): void {
  if (process.platform === 'win32') return;
  try {
    const stats = fs.lstatSync(socketPath);
    if (stats.isSymbolicLink() || (!stats.isSocket() && !stats.isFile())) return;
    if (stats.dev !== identity.dev || stats.ino !== identity.ino) return;
    fs.unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Error cleaning up owned socket ${socketPath}:`, error);
    }
  }
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  let initialStats: fs.Stats;
  try {
    initialStats = fs.lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (initialStats.isSymbolicLink() || !initialStats.isSocket()) {
    throw new Error(`Refusing to replace unexpected Native Host socket path: ${socketPath}`);
  }
  if (typeof process.getuid === 'function' && initialStats.uid !== process.getuid()) {
    throw new Error(`Native Host socket is not owned by the current user: ${socketPath}`);
  }

  await new Promise<void>((resolve, reject) => {
    const probe = net.connect(socketPath);
    const timeout = setTimeout(() => {
      probe.destroy();
      reject(new Error(`Native Host socket state is indeterminate: ${socketPath}`));
    }, 500);
    probe.once('connect', () => {
      clearTimeout(timeout);
      probe.destroy();
      reject(new Error(`Native Host socket is already active: ${socketPath}`));
    });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      probe.destroy();
      if (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') {
        reject(error);
        return;
      }
      try {
        const currentStats = fs.lstatSync(socketPath);
        if (currentStats.dev !== initialStats.dev || currentStats.ino !== initialStats.ino) {
          throw new Error(`Native Host socket changed during stale-path validation: ${socketPath}`);
        }
        fs.unlinkSync(socketPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
          reject(unlinkError as Error);
          return;
        }
      }
      resolve();
    });
  });
}

export function cleanupStaleSocket(socketPath: string): void {
  if (process.platform !== 'win32') {
    try {
      const stats = fs.lstatSync(socketPath);
      if (stats.isSocket() || stats.isFile()) {
        if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
          console.error(`Socket at ${socketPath} is owned by UID ${stats.uid}, not current UID ${process.getuid()}`);
          return;
        }
        fs.unlinkSync(socketPath);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Error cleaning up stale socket ${socketPath}:`, err);
      }
    }
  }
}

export interface NativeMessage {
  id?: number;
  action?: string;
  [key: string]: unknown;
}

const REDACTED_SECRET = '[SECURE_CLIPBOARD_REDACTED]';
const MIN_DERIVED_SECRET_LENGTH = 4;
const MAX_SENSITIVE_GUARDS = 64;
const MAX_SENSITIVE_VALUE_BYTES = 1024 * 1024;
const MAX_GUARD_TTL_SECONDS = 24 * 60 * 60;

interface SensitiveOutputGuard {
  value: string;
  patterns: string[];
  replacement: string;
  expiresAt: number;
}

function sensitivePatterns(value: string): string[] {
  const patterns = [value, JSON.stringify(value)];
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length >= MIN_DERIVED_SECRET_LENGTH) {
    const standardBase64 = bytes.toString('base64');
    const urlSafeBase64 = standardBase64.replace(/\+/g, '-').replace(/\//g, '_');
    const hex = bytes.toString('hex');
    const percentEncoded = Array.from(bytes, (byte) =>
      /[A-Za-z0-9._~-]/.test(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).padStart(2, '0').toUpperCase()}`
    ).join('');
    const percentEncodedLower = percentEncoded.replace(/%[0-9A-F]{2}/g, (token) => token.toLowerCase());
    const wrap = (encoded: string, width: number, separator: string): string =>
      encoded.match(new RegExp(`.{1,${width}}`, 'g'))?.join(separator) || encoded;
    patterns.push(
      standardBase64,
      standardBase64.replace(/=+$/, ''),
      urlSafeBase64,
      urlSafeBase64.replace(/=+$/, ''),
      hex,
      hex.toUpperCase(),
      percentEncoded,
      percentEncodedLower,
      Array.from(value).reverse().join(''),
    );
    for (const encoded of [
      standardBase64,
      standardBase64.replace(/=+$/, ''),
      urlSafeBase64,
      urlSafeBase64.replace(/=+$/, ''),
    ]) {
      for (const width of [64, 76, 80]) {
        patterns.push(wrap(encoded, width, '\n'), wrap(encoded, width, '\r\n'));
      }
    }
  }
  return [...new Set(patterns)].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function safeReplacement(patterns: readonly string[]): string {
  if (!patterns.some((pattern) => REDACTED_SECRET.includes(pattern))) return REDACTED_SECRET;
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint).repeat(3);
    if (!patterns.some((pattern) => candidate.includes(pattern) || pattern.includes(candidate))) return candidate;
  }
  return '\ufffd\ufffd\ufffd';
}

function redactString(value: string, patterns: readonly string[], replacement: string): string {
  let output = value;
  for (const pattern of patterns) {
    if (pattern && output.includes(pattern)) output = output.split(pattern).join(replacement);
  }
  return output;
}

/** Recursively sanitize browser/controller JSON before it crosses the local IPC boundary. */
export function redactSensitiveOutput(
  value: unknown,
  patterns: readonly string[],
  replacement = safeReplacement(patterns),
): unknown {
  if (typeof value === 'string') return redactString(value, patterns, replacement);
  if (typeof value === 'number' && patterns.includes(String(value))) return replacement;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveOutput(item, patterns, replacement));
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      sanitized[redactString(key, patterns, replacement)] = redactSensitiveOutput(item, patterns, replacement);
    }
    return sanitized;
  }
  return value;
}

function stripInternalSensitiveParams(params: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...params };
  delete sanitized.sensitive;
  delete sanitized.guardValue;
  delete sanitized.guardTtlSeconds;
  return sanitized;
}

export class NativeMessagingHost {
  private buffer: Buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;
  private pendingRequests = new Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>();
  private requestIdCounter = 1;
  private ipcServer: net.Server | null = null;
  private rejectIpcStartup: ((error: Error) => void) | null = null;
  private isConnectedToChrome = false;
  private socketPath: string;
  private ipcSocketIdentity: SocketIdentity | null = null;
  private sensitiveOutputGuards: SensitiveOutputGuard[] = [];
  private sensitiveExtractionInProgress = false;
  private browserOutputQuarantined = false;
  private closed = false;
  public readonly ready: Promise<void>;

  constructor(customSocketPath?: string) {
    this.socketPath = customSocketPath || getSocketPath();
    this.setupStdio();
    this.ready = this.setupIpcServer();
  }

  private setupStdio() {
    process.stdin.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    });

    process.stdin.on('end', () => {
      console.error('Chrome Native Messaging stdin closed');
      this.close();
    });

    process.stdin.on('error', (err) => {
      console.error('Chrome Native Messaging stdin error:', err);
    });

    if (typeof process.stdin.unref === 'function') {
      process.stdin.unref();
    }

    // Mark active connection when process is launched by Chrome
    this.isConnectedToChrome = true;
  }

  private processBuffer() {
    while (true) {
      if (this.expectedLength === null) {
        if (this.buffer.length < 4) return;
        this.expectedLength = this.buffer.readUInt32LE(0);
        this.buffer = this.buffer.subarray(4);
      }

      if (this.buffer.length < this.expectedLength) return;

      const messageBuf = this.buffer.subarray(0, this.expectedLength);
      this.buffer = this.buffer.subarray(this.expectedLength);
      this.expectedLength = null;

      try {
        const msg = JSON.parse(messageBuf.toString('utf8')) as NativeMessage;
        this.handleMessageFromChrome(msg);
      } catch (err) {
        console.error('Failed to parse JSON from Chrome:', err);
      }
    }
  }

  public sendToChrome(payload: NativeMessage): void {
    const jsonStr = JSON.stringify(payload);
    const bodyBuf = Buffer.from(jsonStr, 'utf8');
    const headerBuf = Buffer.alloc(4);
    headerBuf.writeUInt32LE(bodyBuf.length, 0);

    process.stdout.write(Buffer.concat([headerBuf, bodyBuf]));
  }

  private handleMessageFromChrome(msg: NativeMessage) {
    if (msg.id !== undefined) {
      if (!this.pendingRequests.has(msg.id)) return;
      const { resolve, reject } = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) reject(new Error(String(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.action === 'getRelayConfig') {
      this.sendRelayConfigToChrome();
      return;
    }
    if (this.sensitiveExtractionInProgress || this.browserOutputQuarantined) return;
    console.error('Received event from Chrome Extension:', this.sanitizeSensitiveOutput(msg));
  }

  private sendRelayConfigToChrome(): void {
    const instance = normalizeInstanceName(process.env.CHROME_CONTROLLER_INSTANCE || 'default');
    const discovery = readDiscovery(instance);
    if (!discovery) {
      this.sendToChrome({ event: 'relayConfigUnavailable' });
      return;
    }
    this.sendToChrome({
      event: 'relayConfig',
      relay: {
        instance,
        wsPort: discovery.wsPort,
        apiKey: discovery.apiKey,
        pid: discovery.pid,
        startedAt: discovery.startedAt,
      },
    });
  }

  public requestFromChrome(
    action: string,
    params: Record<string, unknown> = {},
    internalSensitive = false,
  ): Promise<unknown> {
    const forwardedParams = internalSensitive
      ? { ...params, sensitive: true }
      : stripInternalSensitiveParams(params);
    const requestedTimeout = forwardedParams.timeoutMs;
    const timeoutMs = requestedTimeout === undefined ? 15000 : requestedTimeout;
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
      return Promise.reject(new Error('Native Messaging request timeout must be an integer from 1 to 120000 milliseconds'));
    }
    return new Promise((resolve, reject) => {
      const id = this.requestIdCounter++;
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Native Messaging request timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      try {
        this.sendToChrome({ id, action, ...forwardedParams });
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error('Failed to send Native Messaging request'));
      }
    });
  }

  private removeExpiredSensitiveGuards(now = Date.now()): void {
    const active: SensitiveOutputGuard[] = [];
    for (const guard of this.sensitiveOutputGuards) {
      if (guard.expiresAt > now) {
        active.push(guard);
      } else {
        guard.value = '';
        guard.patterns.fill('');
      }
    }
    this.sensitiveOutputGuards = active;
  }

  private registerSensitiveOutputGuard(value: unknown, ttlSeconds: unknown): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('Sensitive output guard requires a non-empty string value');
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_SENSITIVE_VALUE_BYTES) {
      throw new Error('Sensitive output guard value exceeds the maximum size');
    }

    const ttl = this.validateGuardTtl(ttlSeconds);

    this.removeExpiredSensitiveGuards();
    const existing = this.sensitiveOutputGuards.find((guard) => guard.value === value);
    if (existing) {
      existing.expiresAt = Math.max(existing.expiresAt, Date.now() + ttl * 1000);
      return;
    }
    if (this.sensitiveOutputGuards.length >= MAX_SENSITIVE_GUARDS) {
      throw new Error('Sensitive output guard capacity reached');
    }
    const patterns = sensitivePatterns(value);
    this.sensitiveOutputGuards.push({
      value,
      patterns,
      replacement: safeReplacement(patterns),
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  private validateGuardTtl(ttlSeconds: unknown): number {
    const ttl = ttlSeconds === undefined ? 300 : ttlSeconds;
    if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_GUARD_TTL_SECONDS) {
      throw new Error(`Sensitive output guard TTL must be an integer from 1 to ${MAX_GUARD_TTL_SECONDS} seconds`);
    }
    return ttl;
  }

  private assertGuardCapacity(): void {
    this.removeExpiredSensitiveGuards();
    if (this.sensitiveOutputGuards.length >= MAX_SENSITIVE_GUARDS) {
      throw new Error('Sensitive output guard capacity reached');
    }
  }

  private sanitizeSensitiveOutput(value: unknown): unknown {
    this.removeExpiredSensitiveGuards();
    let sanitized = value;
    for (const guard of this.sensitiveOutputGuards) {
      sanitized = redactSensitiveOutput(sanitized, guard.patterns, guard.replacement);
    }
    return sanitized;
  }

  private async extractSecretGuarded(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.sensitiveExtractionInProgress || this.pendingRequests.size > 0) {
      throw new Error('A guarded extraction or browser request is already in progress');
    }
    const tabId = Number(params.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('Guarded extraction requires a valid tabId');
    const ttl = this.validateGuardTtl(params.ttlSeconds);
    this.assertGuardCapacity();
    const expression = buildGuardedExtractionExpression(params);

    this.sensitiveExtractionInProgress = true;
    try {
      const runtimeResult = await this.requestFromChrome('evaluateOnPage', {
        tabId,
        expression,
        returnByValue: true,
        awaitPromise: true,
        sensitive: true,
        guardTtlSeconds: ttl,
      }, true);
      const outer = runtimeResult as { result?: { value?: unknown }; value?: unknown };
      const payload = outer?.result?.value ?? outer?.value;
      if (!payload || typeof payload !== 'object') {
        throw new Error('Guarded extraction returned an invalid response; no handle was created');
      }
      const extracted = payload as { secret?: unknown; guard?: Record<string, unknown> };
      if ((payload as { beforeSecret?: unknown }).beforeSecret === true) {
        throw new Error('Guarded extraction failed before a secret was captured; no handle was created');
      }
      if (typeof extracted.secret !== 'string' || extracted.secret.trim().length === 0) {
        throw new Error('Guarded extraction did not return a non-empty string; no handle was created');
      }

      // Register before validating/returning any remaining page metadata so all
      // subsequent IPC errors and events are sanitized even on fail-closed paths.
      this.registerSensitiveOutputGuard(extracted.secret, params.ttlSeconds);
      const guarded = extracted.guard?.guarded === true;
      const residual = Number(extracted.guard?.residual ?? 1);
      if (!guarded || residual !== 0) {
        throw new Error('Post-extraction page guard could not verify reachable DOM/AX masking; no handle was created');
      }
      return {
        value: extracted.secret,
        masked: Number(extracted.guard?.masked ?? 0),
      };
    } catch {
      let tabClosed = false;
      try {
        await this.requestFromChrome(
          'removeTab',
          { tabId, sensitive: true, reason: 'guardedExtractionFailure' },
          true,
        );
        tabClosed = true;
      } catch {
        this.browserOutputQuarantined = true;
      }
      if (tabClosed) {
        throw new Error('Guarded extraction failed; the source tab was closed and no handle was created');
      }
      throw new Error('Guarded extraction failed and the source tab could not be closed; browser output is quarantined until the tab is closed manually');
    } finally {
      this.sensitiveExtractionInProgress = false;
    }
  }

  private async injectSecretGuarded(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.sensitiveExtractionInProgress || this.pendingRequests.size > 0) {
      throw new Error('A guarded secret operation or browser request is already in progress');
    }
    const tabId = Number(params.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('Guarded injection requires a valid tabId');
    if (typeof params.selector !== 'string' || params.selector.length === 0) {
      throw new Error('Guarded injection requires a non-empty selector');
    }
    if (typeof params.value !== 'string' || params.value.length === 0) {
      throw new Error('Guarded injection requires a non-empty string value');
    }
    if (Buffer.byteLength(params.value, 'utf8') > MAX_SENSITIVE_VALUE_BYTES) {
      throw new Error('Guarded injection value exceeds the maximum size');
    }
    const ttl = this.validateGuardTtl(params.ttlSeconds);
    this.removeExpiredSensitiveGuards();
    const alreadyGuarded = this.sensitiveOutputGuards.some((guard) => guard.value === params.value);
    if (!alreadyGuarded) this.assertGuardCapacity();
    const expression = buildGuardedInjectionExpression({ selector: params.selector, value: params.value });
    this.registerSensitiveOutputGuard(params.value, ttl);

    this.sensitiveExtractionInProgress = true;
    try {
      const runtimeResult = await this.requestFromChrome('evaluateOnPage', {
        tabId,
        expression,
        returnByValue: true,
        awaitPromise: true,
        sensitive: true,
        guardValue: params.value,
        guardTtlSeconds: ttl,
      }, true);
      const outer = runtimeResult as { result?: { value?: unknown }; value?: unknown };
      const payload = outer?.result?.value ?? outer?.value;
      if (!payload || typeof payload !== 'object' || (payload as { injected?: unknown }).injected !== true) {
        throw new Error('Guarded injection could not verify the target value');
      }
      return { injected: true };
    } catch {
      let tabClosed = false;
      try {
        await this.requestFromChrome(
          'removeTab',
          { tabId, sensitive: true, reason: 'guardedInjectionFailure' },
          true,
        );
        tabClosed = true;
      } catch {
        this.browserOutputQuarantined = true;
      }
      if (tabClosed) throw new Error('Guarded injection failed; the target tab was closed');
      throw new Error('Guarded injection failed and the target tab could not be closed; browser output is quarantined until restart');
    } finally {
      this.sensitiveExtractionInProgress = false;
    }
  }

  private async setupIpcServer(): Promise<void> {
    const socketPath = this.socketPath;
    ensureSocketDir(socketPath);
    await prepareSocketPath(socketPath);
    if (this.closed) throw new Error('Native Host IPC startup was cancelled before binding');

    const MAX_LINE_BYTES = 10 * 1024 * 1024; // 10MB line buffer cap

    this.ipcServer = net.createServer((client) => {
      let lineBuffer = Buffer.alloc(0);

      client.on('error', (err) => {
        console.error('IPC client error:', err);
      });

      client.on('data', async (chunk) => {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        lineBuffer = Buffer.concat([lineBuffer, chunkBuffer]);
        if (lineBuffer.length > MAX_LINE_BYTES) {
          client.destroy(new Error('IPC line exceeds maximum size limit (10MB)'));
          return;
        }

        let newlineIndex: number;
        while ((newlineIndex = lineBuffer.indexOf(0x0a)) >= 0) {
          const lineBytes = lineBuffer.subarray(0, newlineIndex);
          lineBuffer = lineBuffer.subarray(newlineIndex + 1);
          const line = lineBytes.toString('utf8');
          if (!line.trim()) continue;
            try {
              const req = JSON.parse(line) as { id?: number; action: string; [key: string]: unknown };
              const { action, id, ...params } = req;
              try {
                if (this.browserOutputQuarantined) {
                  throw new Error('Browser output is quarantined after an indeterminate guarded extraction; close the source tab manually before restarting the native host');
                }
                if (this.sensitiveExtractionInProgress) {
                  throw new Error('Browser output is locked during guarded extraction');
                }
                if (action === 'extractSecretGuarded') {
                  const result = await this.extractSecretGuarded(params);
                  client.write(JSON.stringify({ id, success: true, result }) + '\n');
                  continue;
                }
                if (action === 'injectSecretGuarded') {
                  const result = await this.injectSecretGuarded(params);
                  client.write(JSON.stringify({ id, success: true, result }) + '\n');
                  continue;
                }
                const result = await this.requestFromChrome(action, stripInternalSensitiveParams(params));
                client.write(JSON.stringify({
                  id,
                  success: true,
                  result: this.sanitizeSensitiveOutput(result),
                }) + '\n');
              } catch (err) {
                client.write(JSON.stringify({
                  id,
                  success: false,
                  error: this.sanitizeSensitiveOutput((err as Error).message),
                }) + '\n');
              }
            } catch {
              client.write(JSON.stringify({ success: false, error: 'Invalid IPC JSON payload' }) + '\n');
            }
        }
      });
    });

    this.ipcServer.on('error', (err) => {
      console.error('Native Host IPC server error:', err);
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveStartup = () => {
        if (settled) return;
        settled = true;
        this.rejectIpcStartup = null;
        resolve();
      };
      const rejectStartup = (error: Error) => {
        if (settled) return;
        settled = true;
        this.rejectIpcStartup = null;
        reject(error);
      };
      this.rejectIpcStartup = rejectStartup;
      const handleStartupError = (error: Error) => {
        try { this.ipcServer!.close(); } catch { /* ignore cleanup error */ }
        rejectStartup(new Error(`Native Host IPC listener failed: ${error.message}`));
      };
      this.ipcServer!.once('error', handleStartupError);
      this.ipcServer!.listen(socketPath, () => {
        this.ipcServer!.removeListener('error', handleStartupError);
        try {
          if (process.platform !== 'win32') {
            fs.chmodSync(socketPath, 0o600);
            const stats = fs.lstatSync(socketPath);
            if (!stats.isSocket()) throw new Error('Native Host IPC path is not a socket');
            this.ipcSocketIdentity = { dev: stats.dev, ino: stats.ino };
          }
        } catch (error) {
          try { this.ipcServer!.close(); } catch { /* ignore cleanup error */ }
          rejectStartup(new Error(`Native Host IPC permission setup failed: ${(error as Error).message}`));
          return;
        }
        if (this.closed) {
          try { this.ipcServer!.close(); } catch { /* ignore cleanup error */ }
          if (this.ipcSocketIdentity) {
            removeSocketIfOwned(socketPath, this.ipcSocketIdentity);
            this.ipcSocketIdentity = null;
          }
          rejectStartup(new Error('Native Host IPC startup was cancelled after binding'));
          return;
        }
        console.error(`Native Host IPC listening on ${socketPath}`);
        resolveStartup();
      });
    });
  }

  public close() {
    this.closed = true;
    this.rejectIpcStartup?.(new Error('Native Host IPC startup was cancelled by close'));
    for (const { reject } of this.pendingRequests.values()) {
      reject(new Error('Native Messaging host is closing'));
    }
    this.pendingRequests.clear();
    for (const guard of this.sensitiveOutputGuards) {
      guard.value = '';
      guard.patterns.fill('');
    }
    this.sensitiveOutputGuards = [];
    if (this.ipcServer) {
      if (typeof (this.ipcServer as any).closeAllConnections === 'function') {
        (this.ipcServer as any).closeAllConnections();
      }
      try { this.ipcServer.close(); } catch { /* listener may not have finished binding */ }
      if (this.ipcSocketIdentity) {
        removeSocketIfOwned(this.socketPath, this.ipcSocketIdentity);
        this.ipcSocketIdentity = null;
      }
    }
    process.stdin.pause();
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('end');
    process.stdin.removeAllListeners('error');
  }
}

// Instantiate native host if launched directly
const isMain = /(?:^|[\\/])native-host\.(?:js|ts)$/.test(process.argv[1] || '');
if (isMain) {
  const host = new NativeMessagingHost();

  void host.ready.catch((error) => {
    console.error(`Native Messaging host startup failed: ${(error as Error).message}`);
    host.close();
    process.exitCode = 1;
  });

  process.on('SIGINT', () => { host.close(); process.exit(0); });
  process.on('SIGTERM', () => { host.close(); process.exit(0); });
}
