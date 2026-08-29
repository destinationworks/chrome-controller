import net from 'node:net';
import fs from 'node:fs';

export const SOCKET_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\chrome-controller-ipc'
  : '/tmp/chrome-controller.sock';

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

  constructor() {
    this.setupStdio();
    this.setupIpcServer();
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

  public requestFromChrome(action: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<unknown> {
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

      this.sendToChrome({ id, action, ...params });
    });
  }

  private setupIpcServer() {
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
    }

    this.ipcServer = net.createServer((client) => {
      let lineBuf = '';

      client.on('data', async (chunk) => {
        lineBuf += chunk.toString('utf8');
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';

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
      });
    });

    this.ipcServer.listen(SOCKET_PATH, () => {
      console.error(`Native Host IPC listening on ${SOCKET_PATH}`);
    });
  }

  public close() {
    if (this.ipcServer) {
      this.ipcServer.close();
      if (process.platform !== 'win32') {
        try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
      }
    }
  }
}

// Instantiate native host if launched directly
const isMain = process.argv[1]?.endsWith('native-host.js') || process.argv[1]?.endsWith('native-host.ts');
if (isMain) {
  const host = new NativeMessagingHost();

  process.on('SIGINT', () => { host.close(); process.exit(0); });
  process.on('SIGTERM', () => { host.close(); process.exit(0); });
}
