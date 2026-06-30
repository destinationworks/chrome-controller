/**
 * MCP (Model Context Protocol) server for Chrome Controller.
 *
 * Translates MCP tool calls into HTTP commands sent to the local
 * Chrome Controller WebSocket/HTTP relay server (src/server.ts).
 *
 * Usage: node dist/mcp.js
 * Or via wrapper:  npx -y @modelcontextprotocol/server-run dist/mcp.js
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DISCOVERY_DIR = path.join(os.homedir(), '.chrome-controller');
const DEFAULT_API_KEY = 'B3C65095-74E1-4F48-9EBB-64F5DD6AB078';
const DEFAULT_HTTP_PORT = 8898;

function readDiscovery(instance: string): { httpPort: number; apiKey: string } | null {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(DISCOVERY_DIR, `${instance}.json`), 'utf8')
    ) as { httpPort: number; apiKey: string };
    return data;
  } catch {
    return null;
  }
}

function getConfig(): { httpPort: number; apiKey: string } {
  // Explicit env vars always win
  if (process.env.HTTP_PORT || process.env.API_KEY) {
    return {
      httpPort: Number(process.env.HTTP_PORT || DEFAULT_HTTP_PORT),
      apiKey: process.env.API_KEY || DEFAULT_API_KEY,
    };
  }
  // Fall back to discovery file for the current instance
  const instance = process.env.CHROME_CONTROLLER_INSTANCE || 'default';
  const discovery = readDiscovery(instance);
  if (discovery) return discovery;
  // Last resort: hardcoded defaults
  return { httpPort: DEFAULT_HTTP_PORT, apiKey: DEFAULT_API_KEY };
}

function sendCommand(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
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
    { name: 'chrome-controller', version: '1.0.0' },
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
        description: 'Query Chrome tabs. Pass empty object to get all tabs.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Match URL pattern' },
            title: { type: 'string', description: 'Match title pattern' },
            active: { type: 'boolean' },
          },
        },
      },
      {
        name: 'chrome_create_tab',
        description: 'Open a new tab and make it controlled.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to open' },
            active: { type: 'boolean', description: 'Whether the tab should be active' },
          },
          required: ['url'],
        },
      },
      {
        name: 'chrome_select_tab',
        description: 'Take control of an existing tab.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'The tab ID to select' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'chrome_mouse',
        description: 'Perform a mouse action on the active/controlled tab.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'The tab ID to evaluate in' },
            type: { type: 'string', enum: ['move', 'press', 'release', 'click', 'wheel'] },
            x: { type: 'number', description: 'X coordinate' },
            y: { type: 'number', description: 'Y coordinate' },
            button: { type: 'string', enum: ['left', 'middle', 'right'], default: 'left' },
          },
          required: ['type', 'x', 'y'],
        },
      },
      {
        name: 'chrome_type_text',
        description: 'Type text into the focused element of the tab.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to type' },
            typingDelayMs: { type: 'number', description: 'Delay between keystrokes in ms (default 55)' },
          },
          required: ['text'],
        },
      },
      {
        name: 'chrome_screenshot',
        description: 'Capture a screenshot of the active/controlled tab. Returns base64 image data.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'The tab ID to evaluate in' },
            format: { type: 'string', enum: ['jpeg', 'png'], default: 'jpeg' },
            quality: { type: 'number', description: 'Quality 0-100 (default 80)' },
          },
        },
      },
      {
        name: 'chrome_capture_video',
        description: 'Capture a short video (sequence of screenshots) from the controlled tab.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'The tab ID to capture' },
            fps: { type: 'number', description: 'Frames per second (default 5)', default: 5 },
            duration: { type: 'number', description: 'Duration in seconds (default 3)', default: 3 },
            format: { type: 'string', enum: ['jpeg', 'png'], default: 'jpeg' },
            quality: { type: 'number', description: 'Quality 0-100 (default 80)', default: 80 },
          },
        },
      },
      {
        name: 'chrome_evaluate',
        description: 'Evaluate JavaScript in the page context.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'The tab ID to evaluate in' },
            expression: { type: 'string', description: 'JavaScript code to execute' },
            awaitPromise: { type: 'boolean', description: 'Wait for promise to resolve', default: true },
            returnByValue: { type: 'boolean', description: 'Return actual value instead of object reference', default: true },
          },
          required: ['expression'],
        },
      },
      {
        name: 'chrome_console_logs',
        description: 'Read the recent console logs (log, warn, error) from the page.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'chrome_release_tab',
        description: 'Release control of a tab without closing it.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'The tab ID to release. If omitted, releases active.' },
          },
        },
      },
      {
        name: 'chrome_cleanup_ai_tabs',
        description: 'Release control of all AI tabs, optionally closing them.',
        inputSchema: {
          type: 'object',
          properties: {
            closeTabs: { type: 'boolean', description: 'Whether to close the tabs (default false)' },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const toolName = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;

      // Health check hits the HTTP relay directly
      if (toolName === 'chrome_controller_health') {
        const { httpPort } = getConfig();
        const res = await fetch(`http://localhost:${httpPort}/health`);
        const json = await res.json();
        return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] };
      }

      // Map MCP tool names → server action names
      const actionMap: Record<string, string> = {
        chrome_evaluate: 'evaluateOnPage',
        chrome_screenshot: 'captureScreenshot',
        chrome_console_logs: 'getConsoleLogs',
        chrome_capture_video: 'captureVideo',
        chrome_cleanup_ai_tabs: 'cleanupManagedTabs',
      };

      let action = actionMap[toolName];
      if (!action) {
        // chrome_query_tabs → queryTabs, chrome_create_tab → createTab, etc.
        action = toolName.replace(/^chrome_/, '').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      }

      const result = await sendCommand(action, args);

      // Return screenshot as image content
      if (toolName === 'chrome_screenshot' && result && typeof result === 'object') {
        const r = result as { data?: string | { data?: string }; format?: string };
        const base64Data = typeof r.data === 'string' ? r.data : (r.data as { data?: string } | undefined)?.data ?? '';
        return {
          content: [{
            type: 'image',
            data: base64Data,
            mimeType: `image/${args.format ?? 'jpeg'}`,
          }],
        };
      }

      // Return video as summary + last 4 frames
      if (toolName === 'chrome_capture_video' && result && typeof result === 'object') {
        const r = result as { frames?: Array<{ data?: string | { data?: string }; error?: string }>; fps?: number; duration?: number; format?: string };
        const frames = r.frames ?? [];
        const images = frames
          .filter((f) => f.data)
          .slice(-4)
          .map((f) => ({
            type: 'image' as const,
            data: typeof f.data === 'string' ? f.data : ((f.data as { data?: string } | undefined)?.data ?? ''),
            mimeType: `image/${r.format ?? 'jpeg'}`,
          }));
        const summary = {
          totalFrames: frames.length,
          fps: r.fps,
          duration: r.duration,
          format: r.format,
          errors: frames.filter((f) => f.error).length,
        };
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, ...images] };
      }

      return {
        content: [{
          type: 'text',
          text: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result),
        }],
      };
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

main().catch((error: Error) => {
  console.error('Fatal error in MCP server:', error);
  process.exit(1);
});
