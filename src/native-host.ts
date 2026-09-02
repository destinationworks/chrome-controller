import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
    try {
      fs.chmodSync(dir, 0o700);
    } catch { /* ignore */ }
  }
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

export class NativeMessagingHost {
  private buffer: Buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;
  private pendingRequests = new Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>();
  private requestIdCounter = 1;
  private ipcServer: net.Server | null = null;
  private isConnectedToChrome = false;
  private socketPath: string;
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
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const { resolve, reject } = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        reject(new Error(String(msg.error)));
      } else {
        resolve(msg.result);
      }
    } else {
      console.error('Received event from Chrome Extension:', msg);
    }
  }

  public requestFromChrome(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.requestIdCounter++;
      const timeoutMs = Number(params.timeoutMs || 15000);
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

      this.sendToChrome({ id, action, ...params });
    });
  }

  private setupIpcServer(): Promise<void> {
    const socketPath = this.socketPath;
    ensureSocketDir(socketPath);
    cleanupStaleSocket(socketPath);

    const MAX_LINE_BYTES = 10 * 1024 * 1024; // 10MB line buffer cap

    this.ipcServer = net.createServer((client) => {
      let lineBuffer = '';

      client.on('error', (err) => {
        console.error('IPC client error:', err);
      });

      client.on('data', async (chunk) => {
        lineBuffer += chunk.toString('utf8');
        if (lineBuffer.length > MAX_LINE_BYTES) {
          client.destroy(new Error('IPC line exceeds maximum size limit (10MB)'));
          return;
        }

        if (lineBuffer.includes('\n')) {
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const req = JSON.parse(line) as { id?: number; action: string; [key: string]: unknown };
              const { action, id, ...params } = req;
              try {
                const result = await this.requestFromChrome(action, params);
                client.write(JSON.stringify({ id, success: true, result }) + '\n');
              } catch (err) {
                client.write(JSON.stringify({ id, success: false, error: (err as Error).message }) + '\n');
              }
            } catch {
              client.write(JSON.stringify({ success: false, error: 'Invalid IPC JSON payload' }) + '\n');
            }
          }
        }
      });
    });

    this.ipcServer.on('error', (err) => {
      console.error('Native Host IPC server error:', err);
    });

    return new Promise<void>((resolve) => {
      this.ipcServer!.listen(socketPath, () => {
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(socketPath, 0o600);
          } catch { /* ignore */ }
        }
        console.error(`Native Host IPC listening on ${socketPath}`);
        resolve();
      });
    });
  }

  public close() {
    if (this.ipcServer) {
      if (typeof (this.ipcServer as any).closeAllConnections === 'function') {
        (this.ipcServer as any).closeAllConnections();
      }
      this.ipcServer.close();
      cleanupStaleSocket(this.socketPath);
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

  process.on('SIGINT', () => { host.close(); process.exit(0); });
  process.on('SIGTERM', () => { host.close(); process.exit(0); });
}
