import { WebSocket, WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Discovery file ─────────────────────────────────────────────────────────────
// Each running server instance writes its actual ports here so agents can find them.
// Default instance name is "default". Set CHROME_CONTROLLER_INSTANCE=<name> to
// run multiple isolated instances simultaneously on the same machine.

export const DISCOVERY_DIR = path.join(os.homedir(), '.chrome-controller');

export interface DiscoveryInfo {
  httpPort: number;
  wsPort: number;
  apiKey: string;
  pid: number;
  startedAt: string;
}

export function writeDiscovery(instance: string, info: DiscoveryInfo): void {
  fs.mkdirSync(DISCOVERY_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DISCOVERY_DIR, `${instance}.json`),
    JSON.stringify(info, null, 2)
  );
}

export function readDiscovery(instance: string): DiscoveryInfo | null {
  const file = path.join(DISCOVERY_DIR, `${instance}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as DiscoveryInfo;
  } catch {
    return null;
  }
}

export function removeDiscovery(instance: string): void {
  try { fs.unlinkSync(path.join(DISCOVERY_DIR, `${instance}.json`)); } catch { /* ignore */ }
}

// ── Defaults ──────────────────────────────────────────────────────────────────
// Use 0 to let the OS pick a free port (recommended for multi-agent setups).
// Set WS_PORT / HTTP_PORT env vars to pin specific ports if needed.

export const DEFAULT_API_KEY = 'B3C65095-74E1-4F48-9EBB-64F5DD6AB078';
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_BATCH_ACTIONS = 50;

export interface ServerConfig {
  wsPort?: number;        // 0 = OS-assigned free port (default)
  httpPort?: number;      // 0 = OS-assigned free port (default)
  apiKey?: string;
  maxBodyBytes?: number;
  defaultTimeoutMs?: number;
  maxBatchActions?: number;
  instance?: string;      // discovery file name, default "default"
  writeDiscoveryFile?: boolean;  // write ~/.chrome-controller/{instance}.json, default true
}

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export interface BatchOptions {
  mode?: 'parallel' | 'sequential';
  stopOnError?: boolean;
}

export interface BatchResult {
  mode: 'parallel' | 'sequential';
  results: Array<{
    index: number;
    action: string;
    success: boolean;
    result?: unknown;
    error?: string;
  }>;
  success: boolean;
}

export interface ChromeControllerServer {
  wss: WebSocketServer;
  server: http.Server;
  httpPort: number;
  wsPort: number;
  apiKey: string;
  instance: string;
  isExtensionReady: () => boolean;
  ready: Promise<{ httpPort: number; wsPort: number }>;
  close: () => void;
}

// ── Factory ────────────────────────────────────────────────────────────────────

export const ALLOWED_BATCH_ACTIONS = new Set([
  'createTab',
  'queryTabs',
  'selectTab',
  'removeTab',
  'updateTab',
  'executeScript',
  'clickSelector',
  'fillSelector',
  'selectOption',
  'snapshotElements',
  'getPageErrors',
  'captureScreenshot',
  'captureVideo',
  'releaseTab',
  'ensureDebugger',
  'attachDebugger',
  'detachDebugger',
  'visualizeAction',
  'evaluateOnPage',
  'clickElement',
  'typeText',
  'navigate',
  'click',
  'type',
  'getConsoleLogs',
  'cleanupManagedTabs',
]);

function isLoopbackAddress(addr?: string): boolean {
  if (!addr) return false;
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr === 'localhost'
  );
}

export function createChromeControllerServer(config: ServerConfig = {}): ChromeControllerServer {
  const apiKey = config.apiKey ?? (process.env.API_KEY || DEFAULT_API_KEY);
  const MAX_BODY_BYTES = config.maxBodyBytes ?? Number(process.env.MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES);
  const DEFAULT_TIMEOUT = config.defaultTimeoutMs ?? Number(process.env.REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const MAX_BATCH = config.maxBatchActions ?? Number(process.env.MAX_BATCH_ACTIONS || DEFAULT_MAX_BATCH_ACTIONS);
  const instance = config.instance ?? (process.env.CHROME_CONTROLLER_INSTANCE || 'default');
  const shouldWriteDiscovery = config.writeDiscoveryFile !== false;

  // 0 = let OS pick a free port; env vars override
  const wsPortHint = config.wsPort ?? Number(process.env.WS_PORT || 0);
  const httpPortHint = config.httpPort ?? Number(process.env.HTTP_PORT || 0);

  let activeClient: WebSocket | null = null;
  const pendingRequests = new Map<number, PendingRequest>();
  let requestIdCounter = 1;

  // ── WebSocket Server ─────────────────────────────────────────────────────────

  const wss = new WebSocketServer({ port: wsPortHint, host: '127.0.0.1' });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const remoteAddr = req.socket.remoteAddress;
    if (!isLoopbackAddress(remoteAddr)) {
      console.error(`Rejected non-loopback WebSocket connection from ${remoteAddr}`);
      ws.close(1008, 'Forbidden: Non-loopback connection rejected');
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.searchParams.get('key') !== apiKey) {
      console.log('Rejected WebSocket connection: Invalid API key');
      ws.close(1008, 'Invalid API key');
      return;
    }

    console.log('Chrome extension connected!');
    if (activeClient && activeClient !== ws) {
      activeClient.close(1000, 'Replaced by a newer extension connection');
    }
    activeClient = ws;

    ws.on('error', console.error);

    ws.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as { id?: number; error?: string; result?: unknown; event?: string };
        if (msg.id && pendingRequests.has(msg.id)) {
          const { resolve, reject } = pendingRequests.get(msg.id)!;
          pendingRequests.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error));
          } else {
            resolve(msg.result);
          }
        } else {
          if (msg.event !== 'ping') {
            console.log('Received from extension:', msg);
          }
        }
      } catch (e) {
        console.error('Error parsing response from extension:', e);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`Chrome extension disconnected (code=${code}, reason=${reason?.toString() || 'none'})`);
      if (activeClient === ws) activeClient = null;
      for (const [, { reject }] of pendingRequests) {
        reject(new Error('Extension disconnected'));
      }
      pendingRequests.clear();
    });
  });

  // ── Utilities ────────────────────────────────────────────────────────────────

  function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  function isExtensionReady(): boolean {
    return Boolean(activeClient && activeClient.readyState === WebSocket.OPEN);
  }

  function sendToExtension(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!isExtensionReady()) {
        return reject(new Error('No Chrome extension is currently connected.'));
      }

      const id = requestIdCounter++;
      const timeoutMs = Number(
        (params.requestTimeoutMs as number | undefined) ??
        (params.timeoutMs as number | undefined) ??
        DEFAULT_TIMEOUT
      );
      const timer = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`Request timed out after ${timeoutMs} ms`));
        }
      }, timeoutMs);
      timer.unref();

      pendingRequests.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      const payload = JSON.stringify({ id, action, ...params });
      activeClient!.send(payload, (err?: Error) => {
        if (err) {
          pendingRequests.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  function normalizeAction(item: unknown, index: number): { action: string; params: Record<string, unknown> } {
    if (!item || typeof item !== 'object') throw new Error(`Batch item ${index} must be an object`);
    const obj = item as Record<string, unknown>;
    if (!obj.action || typeof obj.action !== 'string') throw new Error(`Batch item ${index} is missing action`);
    if (obj.action === 'batch') throw new Error(`Batch item ${index} cannot be a nested batch`);
    if (!ALLOWED_BATCH_ACTIONS.has(obj.action)) {
      throw new Error(`Batch item ${index} specifies disallowed action "${obj.action}"`);
    }
    const { action, ...params } = obj;
    return { action, params };
  }

  async function runBatch(actions: unknown[], options: BatchOptions = {}): Promise<BatchResult> {
    if (!Array.isArray(actions)) throw new Error('Batch payload must include an actions array');
    if (actions.length === 0) throw new Error('Batch actions array cannot be empty');
    if (actions.length > MAX_BATCH) throw new Error(`Batch cannot contain more than ${MAX_BATCH} actions`);

    const mode = options.mode === 'sequential' ? 'sequential' : 'parallel';
    const stopOnError = options.stopOnError !== false;
    const normalized = actions.map(normalizeAction);

    if (mode === 'sequential') {
      const results: BatchResult['results'] = [];
      for (let i = 0; i < normalized.length; i++) {
        const { action, params } = normalized[i];
        try {
          const result = await sendToExtension(action, params);
          results.push({ index: i, action, success: true, result });
        } catch (err) {
          results.push({ index: i, action, success: false, error: (err as Error).message });
          if (stopOnError) break;
        }
      }
      return { mode, results, success: results.every((r) => r.success) };
    }

    const settled = await Promise.allSettled(
      normalized.map(({ action, params }) => sendToExtension(action, params))
    );
    const results = settled.map((item, i) => ({
      index: i,
      action: normalized[i].action,
      success: item.status === 'fulfilled',
      ...(item.status === 'fulfilled'
        ? { result: item.value }
        : { error: (item.reason as Error)?.message || String(item.reason) }),
    }));
    return { mode, results, success: results.every((r) => r.success) };
  }

  function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let body = '';
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        body += chunk.toString();
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
          rejected = true;
          req.pause();
          reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        }
      });
      req.on('end', () => {
        if (rejected) return;
        try { resolve(body ? JSON.parse(body) as Record<string, unknown> : {}); }
        catch { reject(new Error('Invalid JSON payload')); }
      });
      req.on('error', (err) => {
        if (!rejected) reject(err);
      });
    });
  }

  // ── HTTP Server ──────────────────────────────────────────────────────────────

  const httpServer = http.createServer(async (req, res) => {
    const remoteAddr = req.socket.remoteAddress;
    if (!isLoopbackAddress(remoteAddr)) {
      console.error(`Rejected non-loopback HTTP request from ${remoteAddr}`);
      sendJson(res, 403, { success: false, error: 'Forbidden: Non-loopback connection rejected' });
      return;
    }

    // Resolve actual ports after listen
    const actualHttpPort = (httpServer.address() as { port: number })?.port ?? httpPortHint;
    const actualWsPort = (wss.address() as { port: number })?.port ?? wsPortHint;

    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        success: true,
        extensionConnected: isExtensionReady(),
        pendingRequests: pendingRequests.size,
        wsPort: actualWsPort,
        httpPort: actualHttpPort,
        instance,
        uptimeSeconds: Math.round(process.uptime()),
      });
      return;
    }

    if (req.method === 'POST') {
      const providedKey =
        req.headers['x-api-key'] ??
        (req.headers['authorization'] as string | undefined)?.replace(/^Bearer\s+/i, '');
      if (providedKey !== apiKey) {
        sendJson(res, 401, { success: false, error: 'Unauthorized: Invalid or missing API key' });
        return;
      }

      try {
        const command = await readJsonBody(req);
        const actions = (command.actions as unknown[] | undefined) ??
          (command.action === 'batch' ? (command.commands as unknown[] | undefined) : null);

        if (actions) {
          console.log(`Received HTTP batch: ${actions.length} action(s), mode=${command.mode ?? 'parallel'}`);
          const result = await runBatch(actions, {
            mode: command.mode as BatchOptions['mode'],
            stopOnError: command.stopOnError as boolean | undefined,
          });
          sendJson(res, result.success ? 200 : 207, result);
          return;
        }

        if (!command.action) throw new Error('Missing action in payload');

        console.log('Received HTTP command:', command.action);
        try {
          const { action, ...params } = command;
          const result = await sendToExtension(action as string, params);
          sendJson(res, 200, { success: true, result });
        } catch (e) {
          const statusCode = /No Chrome extension/.test((e as Error).message) ? 503 : 400;
          sendJson(res, statusCode, { success: false, error: (e as Error).message });
        }
      } catch (e) {
        console.error('Error handling HTTP command:', (e as Error).message);
        sendJson(res, 400, { success: false, error: (e as Error).message });
      }
    } else {
      sendJson(res, 404, { success: false, error: 'Not found' });
    }
  });

  // Start listening — strictly on 127.0.0.1
  httpServer.listen(httpPortHint, '127.0.0.1', () => {
    const actualHttpPort = (httpServer.address() as { port: number }).port;
    const actualWsPort = (wss.address() as { port: number }).port;

    console.log(`[${instance}] HTTP API  → http://127.0.0.1:${actualHttpPort}`);
    console.log(`[${instance}] WebSocket → ws://127.0.0.1:${actualWsPort}`);
    console.log(`[${instance}] Health    → curl http://127.0.0.1:${actualHttpPort}/health`);

    if (shouldWriteDiscovery) {
      writeDiscovery(instance, {
        httpPort: actualHttpPort,
        wsPort: actualWsPort,
        apiKey,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      console.log(`[${instance}] Discovery → ${DISCOVERY_DIR}/${instance}.json`);
    }
  });

  const ready = new Promise<{ httpPort: number; wsPort: number }>((resolve) => {
    let httpReady = Boolean(httpServer.listening);
    let wsReady = Boolean(wss.address());

    const check = () => {
      if (httpReady && wsReady) {
        const actualHttpPort = (httpServer.address() as { port: number })?.port ?? httpPortHint;
        const actualWsPort = (wss.address() as { port: number })?.port ?? wsPortHint;
        resolve({ httpPort: actualHttpPort, wsPort: actualWsPort });
      }
    };

    if (httpReady && wsReady) {
      check();
    } else {
      if (!httpReady) {
        httpServer.once('listening', () => {
          httpReady = true;
          check();
        });
      }
      if (!wsReady) {
        wss.once('listening', () => {
          wsReady = true;
          check();
        });
      }
    }
  });

  return {
    wss,
    server: httpServer,
    get httpPort() { return (httpServer.address() as { port: number })?.port ?? httpPortHint; },
    get wsPort() { return (wss.address() as { port: number })?.port ?? wsPortHint; },
    apiKey,
    instance,
    isExtensionReady,
    ready,
    close: () => {
      if (shouldWriteDiscovery) removeDiscovery(instance);
      for (const [, req] of pendingRequests) {
        try { req.reject(new Error('Server closed')); } catch {}
      }
      pendingRequests.clear();
      for (const client of wss.clients) {
        try { client.terminate(); } catch {}
      }
      wss.close();
      if (typeof (httpServer as any).closeAllConnections === 'function') {
        (httpServer as any).closeAllConnections();
      }
      httpServer.close();
    },
  };
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

const isMain = /(?:^|[\\/])server\.(?:js|ts)$/.test(process.argv[1] || '');
if (isMain) {
  const srv = createChromeControllerServer();

  // Clean up discovery file on exit
  process.on('SIGINT', () => { srv.close(); process.exit(0); });
  process.on('SIGTERM', () => { srv.close(); process.exit(0); });
}
