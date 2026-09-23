/**
 * MCP (Model Context Protocol) server for Chrome Controller.
 *
 * Translates MCP tool calls into Native Messaging IPC or HTTP commands.
 */

import http from 'node:http';
import { describeIpcFailure, IpcError as TransportIpcError, sendIpcRequest, type IpcResponse } from './ipc-client.js';
import { getSocketPath } from './native-host.js';
import { probeHost, type ProbeResult, type HostState } from './watchdog.js';
import {
  normalizeInstanceName,
  readDiscovery,
  validateRelayApiKey,
} from './discovery.js';

export { readDiscovery } from './discovery.js';

const DEFAULT_HTTP_PORT = 8898;

export const HOST_STATE_REMEDIATION: Record<Exclude<HostState, 'alive'> | 'extensionSilent', string> = {
  wedged:
    'The native host process is alive but its event loop is stuck, so it accepts connections and answers nothing. ' +
    'Run `npm run watchdog -- --recover` to clear it (SIGTERM is swallowed in this state and SIGKILL is required), ' +
    'then re-enable the extension at chrome://extensions to make Chrome spawn a fresh host.',
  'stale-socket':
    'A dead host left its socket file behind. The next host start removes it automatically; ' +
    're-enable the extension at chrome://extensions to spawn one.',
  down:
    'No native host is running. Re-enable the extension at chrome://extensions so Chrome spawns it, ' +
    'and confirm the host manifest is registered with `npm run install-host <EXTENSION_ID>`.',
  extensionSilent:
    'The extension service worker is not responding. Toggle the extension off and on at chrome://extensions ' +
    '(Web Store installs have no Reload button, but the enable toggle restarts the service worker).',
};
export const SOCKET_PATH = getSocketPath();

function relayPort(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('Chrome Controller relay HTTP port must be an integer from 1 to 65535');
  }
  return port;
}

export function getConfig(): { httpPort: number; apiKey: string } {
  const instance = normalizeInstanceName(process.env.CHROME_CONTROLLER_INSTANCE || 'default');
  const discovery = readDiscovery(instance);
  if (process.env.API_KEY) {
    return {
      httpPort: relayPort(process.env.HTTP_PORT, discovery?.httpPort ?? DEFAULT_HTTP_PORT),
      apiKey: validateRelayApiKey(process.env.API_KEY),
    };
  }
  if (process.env.HTTP_PORT) {
    const httpPort = relayPort(process.env.HTTP_PORT, DEFAULT_HTTP_PORT);
    if (discovery?.httpPort === httpPort) return { httpPort, apiKey: discovery.apiKey };
    throw new Error('RELAY_CONFIG_UNAVAILABLE: HTTP_PORT requires API_KEY or a matching private discovery file');
  }
  if (discovery) return { httpPort: discovery.httpPort, apiKey: discovery.apiKey };
  throw new Error('RELAY_CONFIG_UNAVAILABLE: no private Chrome Controller discovery file or explicit API_KEY is available');
}

export const HEALTH_PROBE_TIMEOUT_MS = 3000;
/** The host's wait for Chrome. Must stay strictly below the IPC client timeout
 *  so the host's definitive "Chrome did not answer" wins the race, instead of
 *  the client's ambiguous "IPC timeout". */
export const HEALTH_CHROME_WAIT_MS = 8000;
export const HEALTH_IPC_CLIENT_TIMEOUT_MS = 12000;

/**
 * Builds the health report. A wedged host keeps its socket bound and answers
 * nothing, so the host is probed first and Chrome is only consulted once the
 * host is known to be responsive -- otherwise this tool hangs and still cannot
 * say which side failed.
 */
export async function buildHealthReport(
  probe: () => Promise<ProbeResult>,
  queryTabs: () => Promise<unknown>,
): Promise<Record<string, unknown>> {
  let host: ProbeResult;
  try {
    host = await probe();
  } catch (error) {
    return {
      success: false,
      hostState: 'unknown',
      extensionConnected: false,
      detail: `Could not probe the native host: ${(error as Error).message}`,
      remediation: HOST_STATE_REMEDIATION.down,
    };
  }

  if (host.state !== 'alive') {
    return {
      success: false,
      hostState: host.state,
      extensionConnected: false,
      detail: host.detail,
      remediation: HOST_STATE_REMEDIATION[host.state],
    };
  }

  try {
    return {
      success: true,
      hostState: 'alive',
      extensionConnected: true,
      result: await queryTabs(),
    };
  } catch (error) {
    return {
      success: false,
      hostState: 'alive',
      extensionConnected: false,
      detail: `Native host is healthy but Chrome did not answer: ${(error as Error).message}`,
      remediation: HOST_STATE_REMEDIATION.extensionSilent,
    };
  }
}

/**
 * The host answered `{ success: false }`. This is not a transport failure: its
 * message is the command's real result (e.g. Chrome refusing to script the
 * Web Store), so it is surfaced verbatim and never replayed over the relay.
 */
export class HostRejectedError extends Error {
  readonly kind = 'rejected';

  constructor(message: string) {
    super(message);
    this.name = 'HostRejectedError';
  }
}

/**
 * What sendCommand rejects with on the IPC path: a transport failure
 * (see ipc-client.ts for its kinds) or the host's own rejection.
 */
export type IpcError = TransportIpcError | HostRejectedError;

const RELAY_HINT = 'set CHROME_CONTROLLER_ALLOW_RELAY=1 or HTTP_PORT';

/** Turns a raw IPC failure into the message an operator or agent acts on. */
function describeMcpIpcFailure(error: TransportIpcError, socketPath: string, nativeOnly: boolean): TransportIpcError {
  // The relay hint would be wrong here: enabling the relay cannot help.
  if (error.kind === 'unavailable' && nativeOnly) {
    return new TransportIpcError('unavailable',
      `NATIVE_IPC_UNAVAILABLE: Native Messaging IPC at ${socketPath} is unavailable (${error.message}). ` +
      'This action carries sensitive data and is never sent over the relay.');
  }
  return describeIpcFailure(error, socketPath, RELAY_HINT);
}

/** Resolves the host's result, or rejects with its `success: false` answer. */
function unwrapHostAnswer(answer: IpcResponse, socketPath: string): unknown {
  if (typeof answer.success !== 'boolean') {
    // The host was reached, so this is labelled like any other protocol error.
    throw describeMcpIpcFailure(
      new TransportIpcError('protocol', 'returned a malformed response without a boolean success'), socketPath, false);
  }
  if (!answer.success) throw new HostRejectedError(typeof answer.error === 'string' ? answer.error : 'IPC command failed');
  return answer.result;
}

/**
 * Sends one request over IPC. Resolves with the host's raw answer, or with
 * `undefined` when the socket could not be reached and the relay may be used
 * instead. Every other failure is thrown: the host may already have run the
 * command, so replaying it over the relay could run it twice.
 */
async function tryIpc(
  socketPath: string,
  payload: Record<string, unknown>,
  ipcTimeoutMs: number,
  mayRelay: boolean,
  nativeOnly: boolean,
): Promise<IpcResponse | undefined> {
  try {
    return await sendIpcRequest(socketPath, payload, ipcTimeoutMs);
  } catch (ipcErr) {
    // An invalid timeout or unserializable payload is a caller bug, not a transport failure.
    if (!(ipcErr instanceof TransportIpcError)) throw ipcErr;
    if (ipcErr.kind !== 'unavailable' || !mayRelay) throw describeMcpIpcFailure(ipcErr, socketPath, nativeOnly);
    console.error(`[chrome-controller-mcp] Native Messaging IPC unavailable (${ipcErr.message}), falling back to HTTP relay...`);
    return undefined;
  }
}

export async function sendCommand(
  action: string,
  params: Record<string, unknown> = {},
  ipcTimeoutMs = 10000,
): Promise<unknown> {
  const allowRelay = process.env.CHROME_CONTROLLER_ALLOW_RELAY === '1' || Boolean(process.env.HTTP_PORT);
  const nativeOnly = action === 'extractSecretGuarded' || action === 'injectSecretGuarded' || params.sensitive === true;
  const socketPath = getSocketPath();

  if (!process.env.HTTP_PORT || nativeOnly) {
    const answer = await tryIpc(socketPath, { action, ...params }, ipcTimeoutMs, allowRelay && !nativeOnly, nativeOnly);
    if (answer) return unwrapHostAnswer(answer, socketPath);
  }

  const { httpPort: HTTP_PORT, apiKey: API_KEY } = getConfig();
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ ...params, action });
    const req = http.request(
      {
        hostname: '127.0.0.1',
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
    { name: 'chrome-controller', version: '1.2.1' },
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
      {
        name: 'chrome_type_text',
        description: 'Type text into focused Chrome field with realistic typing delay or instant mode.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'Chrome tab id.' },
            text: { type: 'string', description: 'Text to insert.' },
            typingDelayMs: { type: 'number', description: 'Delay per character in ms. Default 50.' },
            sound: { type: 'boolean', description: 'Enable typing sounds. Default true.' },
            instant: { type: 'boolean', description: 'Insert instantly without delay. Default false.' },
          },
          required: ['tabId', 'text'],
        },
      },
      {
        name: 'chrome_mouse',
        description: 'Simulate mouse movement or click in Chrome tab via CDP.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'Chrome tab id.' },
            action: { type: 'string', enum: ['move', 'press', 'release', 'click'], description: 'Mouse action.' },
            x: { type: 'number', description: 'X coordinate in pixels.' },
            y: { type: 'number', description: 'Y coordinate in pixels.' },
            button: { type: 'string', enum: ['none', 'left', 'middle', 'right'], description: 'Mouse button.' },
            clickCount: { type: 'number', description: 'Click count. Default 1.' },
          },
          required: ['tabId', 'action', 'x', 'y'],
        },
      },
      {
        name: 'chrome_extract_content',
        description: 'Extract structured text content (headings, sections, links, tables) from a Chrome tab.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'Chrome tab id.' },
            maxDepth: { type: 'number', description: 'Max heading depth 1-6. Default 3.' },
            maxLength: { type: 'number', description: 'Max total length. Default 15000.' },
            includeLinks: { type: 'boolean', description: 'Include extracted links. Default true.' },
            includeTables: { type: 'boolean', description: 'Include table data. Default true.' },
            untruncated: { type: 'boolean', description: 'Bypass truncation. Default false.' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'chrome_extract_regions',
        description: 'Extract visible text regions/cards from a Chrome tab page.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'Chrome tab id.' },
            minTextLength: { type: 'number', description: 'Min text length. Default 30.' },
            maxResults: { type: 'number', description: 'Max results. Default 50.' },
            untruncated: { type: 'boolean', description: 'Return full text without truncation.' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'chrome_console_logs',
        description: 'Capture console log entries from a Chrome tab page.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'number', description: 'Chrome tab id.' },
            timeoutMs: { type: 'number', description: 'Collection window in ms. Default 2000.' },
          },
          required: ['tabId'],
        },
      },
      {
        name: 'chrome_cleanup_ai_tabs',
        description: 'Clean up or release tabs managed by AI tools.',
        inputSchema: {
          type: 'object',
          properties: {
            closeTabs: { type: 'boolean', description: 'Close tabs instead of releasing. Default false.' },
            windowId: { type: 'number', description: 'Target window id.' },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args = {} } = request.params;

    try {
      if (toolName === 'chrome_controller_health') {
        const report = await buildHealthReport(
          () => probeHost(getSocketPath(), HEALTH_PROBE_TIMEOUT_MS),
          () => sendCommand('queryTabs', { timeoutMs: HEALTH_CHROME_WAIT_MS }, HEALTH_IPC_CLIENT_TIMEOUT_MS),
        );
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
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

      if (toolName === 'chrome_type_text') {
        const result = await sendCommand('batch', {
          mode: 'sequential',
          actions: [
            { action: 'ensureDebugger', tabId: args.tabId },
            {
              action: 'sendCommand',
              tabId: args.tabId,
              method: 'Input.insertText',
              commandParams: {
                text: args.text,
                animateTyping: !args.instant,
                typingDelayMs: args.typingDelayMs ?? 50,
                sound: args.sound !== false,
              },
            },
          ],
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (toolName === 'chrome_mouse') {
        const mouseType = (args.type ?? args.action ?? 'click') as string;
        const button = (args.button as string) ?? (mouseType === 'move' ? 'none' : 'left');
        const move = {
          action: 'sendCommand',
          tabId: args.tabId,
          method: 'Input.dispatchMouseEvent',
          commandParams: { type: 'mouseMoved', x: args.x, y: args.y, button: 'none' },
        };
        const press = {
          action: 'sendCommand',
          tabId: args.tabId,
          method: 'Input.dispatchMouseEvent',
          commandParams: { type: 'mousePressed', x: args.x, y: args.y, button, clickCount: (args.clickCount as number) || 1 },
        };
        const release = {
          action: 'sendCommand',
          tabId: args.tabId,
          method: 'Input.dispatchMouseEvent',
          commandParams: { type: 'mouseReleased', x: args.x, y: args.y, button, clickCount: (args.clickCount as number) || 1 },
        };
        const actions =
          mouseType === 'move' ? [move] :
          mouseType === 'press' ? [press] :
          mouseType === 'release' ? [release] :
          [move, press, release];

        const result = await sendCommand('batch', {
          mode: 'sequential',
          actions: [
            { action: 'ensureDebugger', tabId: args.tabId },
            ...actions,
          ],
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (toolName === 'chrome_extract_content') {
        const maxDepth = (args.maxDepth as number) ?? 3;
        const maxLength = args.untruncated ? 1000000 : ((args.maxLength as number) ?? 15000);
        const includeLinks = args.includeLinks !== false;
        const includeTables = args.includeTables !== false;
        const expression = `(() => {
          const maxDepth = ${maxDepth};
          const maxLength = ${maxLength};
          const includeLinks = ${includeLinks};
          const includeTables = ${includeTables};

          const result = { headings: [], sections: [], links: [], tables: [] };
          let totalLen = 0;

          document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
            const level = parseInt(h.tagName[1]);
            if (level <= maxDepth && h.offsetParent) {
              result.headings.push({ level, text: h.innerText.trim().substring(0, 200) });
              totalLen += h.innerText.length;
            }
          });

          const textBlocks = [];
          const blockSelectors = 'p, li, blockquote, dt, dd, figcaption, td, th, .content, .text, .description';
          document.querySelectorAll(blockSelectors).forEach(el => {
            if (el.offsetParent && !el.closest('script, style, noscript, .chrome-controller-overlay-root')) {
              const text = el.innerText.trim();
              if (text.length > 10) textBlocks.push(text);
            }
          });

          const seen = new Set();
          textBlocks.forEach(text => {
            const key = text.substring(0, 50);
            if (!seen.has(key) && text.length <= 500) {
              seen.add(key);
              result.sections.push(text.substring(0, 500));
              totalLen += text.length;
            }
          });

          if (includeLinks) {
            document.querySelectorAll('a[href]').forEach(a => {
              if (a.offsetParent && a.innerText.trim()) {
                const text = a.innerText.trim().substring(0, 150);
                const href = a.getAttribute('href') || '';
                if (!seen.has('l:' + href.substring(0, 30))) {
                  seen.add('l:' + href.substring(0, 30));
                  result.links.push({ text, href });
                  totalLen += text.length + href.length;
                }
              }
            });
          }

          if (includeTables) {
            document.querySelectorAll('table').forEach(t => {
              if (t.offsetParent) {
                const rows = [];
                t.querySelectorAll('tr').forEach(tr => {
                  const cells = [];
                  tr.querySelectorAll('td, th').forEach(cell => { cells.push(cell.innerText.trim().substring(0, 200)); });
                  if (cells.length > 0) rows.push(cells);
                  if (rows.length >= 20) return;
                });
                if (rows.length > 0 && rows.length <= 50) { result.tables.push(rows); totalLen += rows.length * 100; }
              }
            });
          }

          if (totalLen > maxLength) {
            result.sections = result.sections.filter(s => s.length < 200);
            result.links = result.links.slice(0, 10);
          }

          return result;
        })()`;
        const data = await sendCommand('evaluateOnPage', { tabId: args.tabId, expression, returnByValue: true, awaitPromise: true });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      if (toolName === 'chrome_extract_regions') {
        const minLen = (args.minTextLength as number) ?? 30;
        const maxResults = (args.maxResults as number) ?? 50;
        const maxTextLen = args.untruncated ? 5000 : 500;
        const expression = `(() => {
          const regions = [];
          const seen = new Set();
          const selectors = [
            '[class*="card"], [class*="item"], [class*="result"], [class*="post"]',
            '[class*="listing"], [class*="entry"], [class*="job"], [class*="vacancy"]',
            '[class*="product"], [class*="review"], [class*="comment"], [class*="article"]'
          ].join(',');

          document.querySelectorAll(selectors).forEach(el => {
            if (!el.offsetParent || el.closest('.chrome-controller-overlay-root')) return;
            const text = el.innerText.trim();
            if (text.length < ${minLen}) return;
            const cls = typeof el.className === 'string' ? el.className : '';
            const key = cls + ':' + text.substring(0, 40);
            if (seen.has(key)) return;
            seen.add(key);
            const links = [];
            el.querySelectorAll('a[href]').forEach(a => {
              links.push({ text: a.innerText.trim().substring(0, 100), href: a.getAttribute('href') });
            });
            regions.push({ class: cls, text: text.substring(0, ${maxTextLen}), links: links.slice(0, 3) });
            if (regions.length >= ${maxResults}) return;
          });

          return regions;
        })()`;
        const data = await sendCommand('evaluateOnPage', { tabId: args.tabId, expression, returnByValue: true, awaitPromise: true });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      if (toolName === 'chrome_console_logs') {
        const result = await sendCommand('getConsoleLogs', { tabId: args.tabId, timeoutMs: args.timeoutMs ?? 2000 });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (toolName === 'chrome_cleanup_ai_tabs') {
        const result = await sendCommand('cleanupManagedTabs', { closeTabs: args.closeTabs === true, windowId: args.windowId });
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
