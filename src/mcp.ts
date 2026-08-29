/**
 * MCP (Model Context Protocol) server for Chrome Controller.
 *
 * Translates MCP tool calls into Native Messaging IPC or HTTP commands.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const DISCOVERY_DIR = path.join(os.homedir(), '.chrome-controller');
const DEFAULT_API_KEY = 'B3C65095-74E1-4F48-9EBB-64F5DD6AB078';
const DEFAULT_HTTP_PORT = 8898;
const SOCKET_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\chrome-controller-ipc'
  : '/tmp/chrome-controller.sock';

export function readDiscovery(instance: string): { httpPort: number; apiKey: string } | null {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(DISCOVERY_DIR, `${instance}.json`), 'utf8')
    ) as { httpPort: number; apiKey: string };
    return data;
  } catch {
    return null;
  }
}

export function getConfig(): { httpPort: number; apiKey: string } {
  if (process.env.HTTP_PORT || process.env.API_KEY) {
    return {
      httpPort: Number(process.env.HTTP_PORT || DEFAULT_HTTP_PORT),
      apiKey: process.env.API_KEY || DEFAULT_API_KEY,
    };
  }
  const instance = process.env.CHROME_CONTROLLER_INSTANCE || 'default';
  const discovery = readDiscovery(instance);
  if (discovery) return discovery;
  return { httpPort: DEFAULT_HTTP_PORT, apiKey: DEFAULT_API_KEY };
}

function sendIpcCommand(action: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = net.connect(SOCKET_PATH, () => {
      client.write(JSON.stringify({ action, ...params }) + '\n');
    });

    let dataStr = '';
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('IPC timeout'));
    }, timeoutMs);

    client.on('data', (chunk) => {
      dataStr += chunk.toString('utf8');
      if (dataStr.includes('\n')) {
        clearTimeout(timer);
        client.end();
        try {
          const parsed = JSON.parse(dataStr.trim()) as { success?: boolean; result?: unknown; error?: string };
          if (parsed.success) resolve(parsed.result);
          else reject(new Error(parsed.error ?? 'IPC command failed'));
        } catch {
          reject(new Error('Invalid IPC JSON response'));
        }
      }
    });

    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function sendCommand(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (!process.env.HTTP_PORT) {
    try {
      return await sendIpcCommand(action, params);
    } catch {
      // IPC unavailable, fall through to HTTP relay
    }
  }

  const { httpPort: HTTP_PORT, apiKey: API_KEY } = getConfig();
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ ...params, action });
      const req = http.request(
        {
          hostname: 'localhost',
          port: HTTP_PORT,
          path: '/',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'Content-Length': Buffer.byteLength(data),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body) as { success?: boolean; result?: unknown; error?: string };
              if (res.statusCode === 200 && parsed.success) {
                resolve(parsed.result);
              } else {
                reject(new Error(parsed.error ?? `HTTP ${res.statusCode}`));
              }
            } catch (e) {
              reject(new Error(`Failed to parse response: ${(e as Error).message}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
}

async function main(): Promise<void> {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  const server = new Server(
    { name: 'chrome-controller', version: '1.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'chrome_controller_health',
        description: 'Check if the Chrome extension is connected and healthy.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'chrome_query_tabs',
        description: 'List visible Chrome tabs.',
        inputSchema: {
          type: 'object',
          properties: {
            queryInfo: { type: 'object', description: 'Chrome tabs.query filter object.' },
          },
        },
      },
      {
        name: 'chrome_create_tab',
        description: 'Open a URL in Chrome.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to open.' },
            active: { type: 'boolean', description: 'Make active.' },
          },
          required: ['url'],
        },
      },
      {
        name: 'chrome_select_tab',
        description: 'Select controlled tab.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            activate: { type: 'boolean' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'chrome_release_tab',
        description: 'Release controlled tab marker.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            reason: { type: 'string' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'chrome_click',
        description: 'Click element by CSS selector or elementId tag.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            selector: { type: 'string' },
            elementId: { type: 'number' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'chrome_fill',
        description: 'Fill text into input/textarea by selector or elementId tag.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            selector: { type: 'string' },
            elementId: { type: 'number' },
            text: { type: 'string' },
          },
          required: ['tabId', 'text'],
        },
      },
      {
        name: 'chrome_select_option',
        description: 'Choose option in dropdown select by selector or elementId tag.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            selector: { type: 'string' },
            elementId: { type: 'number' },
            value: { type: 'string' },
          },
          required: ['tabId', 'value'],
        },
      },
      {
        name: 'chrome_snapshot_elements',
        description: 'Scan interactive page elements with numerical visual tags.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            showOverlay: { type: 'boolean' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'chrome_get_page_errors',
        description: 'Retrieve trapped window, console.error, and network errors.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'chrome_screenshot',
        description: 'Capture screenshot of Chrome tab via CDP.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
            quality: { type: 'number' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'chrome_capture_video',
        description: 'Capture video stream from Chrome tab.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            fps: { type: 'number' },
            duration: { type: 'number' },
            format: { type: 'string', enum: ['jpeg', 'png'] },
            quality: { type: 'number' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'chrome_evaluate',
        description: 'Evaluate JS in Chrome tab.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number' },
            expression: { type: 'string' },
            returnByValue: { type: 'boolean' },
            awaitPromise: { type: 'boolean' },
          },
          required: ['tabId', 'expression'],
        },
      },
      {
        name: 'chrome_batch',
        description: 'Send batch of Chrome actions.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['parallel', 'sequential'] },
            stopOnError: { type: 'boolean' },
            actions: { type: 'array' },
          },
          required: ['actions'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args = {} } = request.params;

    try {
      if (toolName === 'chrome_controller_health') {
        const result = await sendCommand('queryTabs', {});
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, extensionConnected: true, result }, null, 2) }] };
      }

      if (toolName === 'chrome_query_tabs') {
        const result = await sendCommand('queryTabs', { queryInfo: args.queryInfo ?? {} });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (toolName === 'chrome_create_tab') {
        const result = await sendCommand('createTab', { url: args.url, active: args.active });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (toolName === 'chrome_select_tab') {
        const result = await sendCommand('selectTab', { tabId: args.tabId, activate: args.activate });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (toolName === 'chrome_release_tab') {
        const result = await sendCommand('releaseTab', { tabId: args.tabId, reason: args.reason });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (toolName === 'chrome_click') {
        const result = await sendCommand('clickSelector', { tabId: args.tabId, selector: args.selector, elementId: args.elementId });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (toolName === 'chrome_fill') {
        const result = await sendCommand('fillSelector', { tabId: args.tabId, selector: args.selector, elementId: args.elementId, text: args.text });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (toolName === 'chrome_select_option') {
        const result = await sendCommand('selectOption', { tabId: args.tabId, selector: args.selector, elementId: args.elementId, value: args.value });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (toolName === 'chrome_snapshot_elements') {
        const result = await sendCommand('snapshotElements', { tabId: args.tabId, showOverlay: args.showOverlay });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (toolName === 'chrome_get_page_errors') {
        const result = await sendCommand('getPageErrors', { tabId: args.tabId });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (toolName === 'chrome_screenshot') {
        const data = await sendCommand('captureScreenshot', { tabId: args.tabId, screenshotOptions: { format: args.format ?? 'png', quality: args.quality } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      if (toolName === 'chrome_capture_video') {
        const data = await sendCommand('captureVideo', { tabId: args.tabId, fps: args.fps, duration: args.duration, format: args.format, quality: args.quality });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      if (toolName === 'chrome_evaluate') {
        const data = await sendCommand('evaluateOnPage', { tabId: args.tabId, expression: args.expression, returnByValue: args.returnByValue !== false, awaitPromise: args.awaitPromise !== false });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      if (toolName === 'chrome_batch') {
        const result = await sendCommand('batch', { mode: args.mode, stopOnError: args.stopOnError, actions: args.actions });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      throw new Error(`Unknown MCP tool: ${toolName}`);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: Error) => {
    console.error('Fatal error in MCP server:', error);
    process.exit(1);
  });
} else if (import.meta.url.endsWith('/mcp.js') || import.meta.url.endsWith('/mcp.ts')) {
  const isMainModule = process.argv[1]?.replace(/\.js$/, '.ts') === import.meta.url.replace(/\.js$/, '.ts')
    || process.argv[1]?.endsWith('mcp.ts')
    || process.argv[1]?.endsWith('mcp.js');
  if (isMainModule) {
    main().catch((error: Error) => {
      console.error('Fatal error in MCP server:', error);
      process.exit(1);
    });
  }
}
