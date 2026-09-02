/**
 * Pi / Antigravity extension entry point for Chrome Controller.
 *
 * Registers all chrome_* tools with the Pi agent runtime.
 * Tools communicate via Native Messaging IPC socket (/tmp/chrome-controller.sock)
 * with fallback to the local HTTP relay server (src/server.ts) on port 8898.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { getSocketPath } from './native-host.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8898';
const DEFAULT_API_KEY = 'B3C65095-74E1-4F48-9EBB-64F5DD6AB078';
const DISCOVERY_DIR = path.join(os.homedir(), '.chrome-controller');
const SOCKET_PATH = getSocketPath();

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

type ChromeAction = {
  action: string;
  [key: string]: unknown;
};

type ChromeResponse = {
  success?: boolean;
  result?: unknown;
  results?: unknown;
  error?: string;
  extensionConnected?: boolean;
  pendingRequests?: number;
  mode?: string;
};

function baseUrl(): string {
  if (process.env.CHROME_CONTROLLER_URL) return process.env.CHROME_CONTROLLER_URL;
  const instance = process.env.CHROME_CONTROLLER_INSTANCE || 'default';
  const discovery = readDiscovery(instance);
  if (discovery) return `http://127.0.0.1:${discovery.httpPort}`;
  return DEFAULT_BASE_URL;
}

function apiKey(): string {
  if (process.env.CHROME_CONTROLLER_API_KEY) return process.env.CHROME_CONTROLLER_API_KEY;
  const instance = process.env.CHROME_CONTROLLER_INSTANCE || 'default';
  const discovery = readDiscovery(instance);
  if (discovery) return discovery.apiKey;
  return DEFAULT_API_KEY;
}

function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    details: value && typeof value === 'object' ? (value as Record<string, unknown>) : { value },
  };
}

function sendIpcRequest(payload: Record<string, unknown>, timeoutMs = 10000): Promise<ChromeResponse> {
  const socketPath = getSocketPath();
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath, () => {
      client.write(JSON.stringify(payload) + '\n');
    });

    let dataStr = '';
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('IPC socket request timeout'));
    }, timeoutMs);

    client.on('data', (chunk) => {
      dataStr += chunk.toString('utf8');
      if (dataStr.includes('\n')) {
        clearTimeout(timer);
        client.end();
        try {
          const parsed = JSON.parse(dataStr.trim()) as ChromeResponse;
          resolve(parsed);
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

async function chromeRequest(payload: ChromeAction | Record<string, unknown>, signal?: AbortSignal): Promise<ChromeResponse> {
  const allowRelay = process.env.CHROME_CONTROLLER_ALLOW_RELAY === '1' || Boolean(process.env.CHROME_CONTROLLER_URL) || Boolean(process.env.HTTP_PORT);
  const socketPath = getSocketPath();

  if (process.env.NODE_ENV !== 'test' && !process.env.CHROME_CONTROLLER_URL) {
    try {
      return await sendIpcRequest(payload as Record<string, unknown>);
    } catch (ipcErr) {
      if (!allowRelay) {
        throw new Error(
          `NATIVE_IPC_UNAVAILABLE: Native Messaging IPC at ${socketPath} is unavailable (${(ipcErr as Error).message}). ` +
          `Zero-ports Native Messaging is the primary protocol. Fallback to network relay requires explicit activation (set CHROME_CONTROLLER_ALLOW_RELAY=1 or CHROME_CONTROLLER_URL).`
        );
      }
      console.error(`[chrome-controller-pi] Native Messaging IPC failed (${(ipcErr as Error).message}), falling back to HTTP relay...`);
    }
  }

  const response = await fetch(baseUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey(),
    },
    body: JSON.stringify(payload),
    signal,
  });
  const data = (await response.json()) as ChromeResponse;
  if (!response.ok && !data.success) {
    throw new Error(data.error ?? `Chrome Controller returned HTTP ${response.status}`);
  }
  return data;
}

async function chromeHealth(signal?: AbortSignal): Promise<ChromeResponse> {
  const allowRelay = process.env.CHROME_CONTROLLER_ALLOW_RELAY === '1' || Boolean(process.env.CHROME_CONTROLLER_URL) || Boolean(process.env.HTTP_PORT);
  const socketPath = getSocketPath();

  if (process.env.NODE_ENV !== 'test' && !process.env.CHROME_CONTROLLER_URL) {
    try {
      const ipcRes = await sendIpcRequest({ action: 'queryTabs' });
      if (ipcRes.success) {
        return { success: true, extensionConnected: true, mode: 'NativeMessagingIPC' };
      }
    } catch (ipcErr) {
      if (!allowRelay) {
        throw new Error(
          `NATIVE_IPC_UNAVAILABLE: Native Messaging IPC at ${socketPath} is unavailable (${(ipcErr as Error).message}). ` +
          `Zero-ports Native Messaging is the primary protocol. Fallback to network relay requires explicit activation.`
        );
      }
    }
  }

  const response = await fetch(`${baseUrl()}/health`, { signal });
  const data = (await response.json()) as ChromeResponse;
  if (!response.ok) {
    throw new Error(data.error ?? `Chrome Controller health returned HTTP ${response.status}`);
  }
  return data;
}

function debuggerBatch(tabId: number, actions: ChromeAction[]) {
  return {
    action: 'batch',
    mode: 'sequential',
    actions: [
      { action: 'ensureDebugger', tabId },
      ...actions,
    ],
  };
}

export default function chromeControllerPiExtension(pi: ExtensionAPI): void {
  // ── Health ──────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_controller_health',
    label: 'Chrome Controller Health',
    description: 'Check whether the local Chrome Controller server or Native Messaging IPC is active and connected.',
    promptSnippet: 'Check the local Chrome Controller bridge state.',
    promptGuidelines: [
      'Use chrome_controller_health before browser-control work when connection state is unknown.',
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return textResult(await chromeHealth(signal));
    },
  });

  // ── Query Tabs ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_query_tabs',
    label: 'Chrome Query Tabs',
    description: 'List Chrome tabs visible to the Chrome Controller extension.',
    promptSnippet: 'List Chrome tabs through Chrome Controller.',
    promptGuidelines: [
      'Use chrome_query_tabs to find the tabId before selecting, clicking, or typing into Chrome.',
    ],
    parameters: Type.Object({
      queryInfo: Type.Optional(Type.Any({ description: 'Chrome tabs.query filter object.' })),
      mode: Type.Optional(
        Type.Union([Type.Literal('short'), Type.Literal('full')], {
          description: "Response format mode. Defaults to 'short'.",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const data = await chromeRequest({ action: 'queryTabs', queryInfo: params.queryInfo ?? {} }, signal);
      if (params.mode !== 'full' && Array.isArray(data.result)) {
        data.result = (data.result as Record<string, unknown>[]).map((tab) => ({
          id: tab['id'],
          title: tab['title'],
          url: tab['url'],
          active: tab['active'],
          windowId: tab['windowId'],
        }));
      }
      return textResult(data);
    },
  });

  // ── Create Tab ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_create_tab',
    label: 'Chrome Create Tab',
    description: 'Open a URL in Chrome and mark that tab as controlled by Chrome Controller.',
    promptSnippet: 'Open a Chrome tab through Chrome Controller.',
    promptGuidelines: ['Use chrome_create_tab when the task needs a new controlled browser tab.'],
    parameters: Type.Object({
      url: Type.String({ description: 'URL to open.' }),
      active: Type.Optional(Type.Boolean({ description: 'Whether the new tab should become active. Defaults to true.' })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: 'createTab', url: params.url, active: params.active }, signal));
    },
  });

  // ── Select Tab ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_select_tab',
    label: 'Chrome Select Tab',
    description: 'Mark a Chrome tab as the controlled tab and optionally activate it.',
    promptSnippet: 'Select the controlled Chrome tab.',
    promptGuidelines: [
      'Use chrome_select_tab before browser actions if a tab exists but is not yet visually marked as controlled.',
    ],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      activate: Type.Optional(Type.Boolean({ description: 'Whether Chrome should activate the tab. Defaults to true.' })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: 'selectTab', tabId: params.tabId, activate: params.activate }, signal));
    },
  });

  // ── Release Tab ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_release_tab',
    label: 'Chrome Release Tab',
    description: 'Release the active Chrome Controller marker from a tab.',
    promptSnippet: 'Release Chrome Controller control marker from a tab.',
    promptGuidelines: ['Use chrome_release_tab when control is finished but the tab should stay open.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      reason: Type.Optional(Type.String({ description: 'Short reason shown in the page overlay action feed.' })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: 'releaseTab', tabId: params.tabId, reason: params.reason }, signal));
    },
  });

  // ── Cleanup AI Tabs ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_cleanup_ai_tabs',
    label: 'Chrome Cleanup AI Tabs',
    description: "Release or close tabs in Chrome Controller's AI Tool tab group.",
    promptSnippet: 'Clean up Chrome Controller managed tabs.',
    promptGuidelines: [
      'Use chrome_cleanup_ai_tabs with closeTabs false to clear active markers; use closeTabs true only when the user explicitly wants managed tabs closed.',
    ],
    parameters: Type.Object({
      closeTabs: Type.Optional(Type.Boolean({ description: 'When true, close all tabs in the AI Tool group. Defaults to false.' })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: 'cleanupManagedTabs', closeTabs: params.closeTabs === true }, signal));
    },
  });

  // ── High-Level Click ───────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_click',
    label: 'Chrome Click Element',
    description: 'Click an element in Chrome by CSS selector or elementId tag.',
    promptSnippet: 'Click an element in a Chrome tab.',
    promptGuidelines: ['Use chrome_click to click elements by CSS selector or numerical elementId tag from chrome_snapshot_elements.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      selector: Type.Optional(Type.String({ description: 'CSS selector of the element to click.' })),
      elementId: Type.Optional(Type.Number({ description: 'Numerical element ID tag from chrome_snapshot_elements.' })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: 'clickSelector', tabId: params.tabId, selector: params.selector, elementId: params.elementId }, signal));
    },
  });

  // ── High-Level Fill ────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_fill',
    label: 'Chrome Fill Input',
    description: 'Input text into a field in Chrome by CSS selector or elementId tag.',
    promptSnippet: 'Fill text into an input or textarea field in a Chrome tab.',
    promptGuidelines: ['Use chrome_fill to input text into elements by CSS selector or elementId tag from chrome_snapshot_elements.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      selector: Type.Optional(Type.String({ description: 'CSS selector of input or textarea.' })),
      elementId: Type.Optional(Type.Number({ description: 'Numerical element ID tag from chrome_snapshot_elements.' })),
      text: Type.String({ description: 'Text content to fill into the input field.' }),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: 'fillSelector', tabId: params.tabId, selector: params.selector, elementId: params.elementId, text: params.text }, signal));
    },
  });

  // ── High-Level Select Option ───────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_select_option',
    label: 'Chrome Select Option',
    description: 'Select an option in an HTML <select> dropdown by CSS selector or elementId tag.',
    promptSnippet: 'Select an option in a Chrome dropdown element.',
    promptGuidelines: ['Use chrome_select_option to choose a value in an HTML select dropdown.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      selector: Type.Optional(Type.String({ description: 'CSS selector of select dropdown.' })),
      elementId: Type.Optional(Type.Number({ description: 'Numerical element ID tag from chrome_snapshot_elements.' })),
      value: Type.String({ description: 'Option value to select.' }),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: 'selectOption', tabId: params.tabId, selector: params.selector, elementId: params.elementId, value: params.value }, signal));
    },
  });

  // ── Element Snapshotting ───────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_snapshot_elements',
    label: 'Chrome Snapshot Elements',
    description: 'Scan interactive elements on the page, label them with numerical badge tags ([1], [2]...), and return element map.',
    promptSnippet: 'Snapshot interactive page elements with visual ID tags.',
    promptGuidelines: ['Use chrome_snapshot_elements before interacting with complex UI pages to easily find element IDs.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      showOverlay: Type.Optional(Type.Boolean({ description: 'Whether to show visual badge overlays on screen. Defaults to true.' })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: 'snapshotElements', tabId: params.tabId, showOverlay: params.showOverlay }, signal));
    },
  });

  // ── Get Page Errors ────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_get_page_errors',
    label: 'Chrome Get Page Errors',
    description: 'Retrieve continuous window, console.error, and network errors captured on the page.',
    promptSnippet: 'Get accumulated JS console and network errors from a Chrome tab page.',
    promptGuidelines: ['Use chrome_get_page_errors to inspect uncaught exceptions and console.error messages.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: 'getPageErrors', tabId: params.tabId }, signal));
    },
  });

  // ── Mouse ───────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_mouse',
    label: 'Chrome Mouse',
    description: 'Move, press, release, or click the mouse in a Chrome tab via CDP.',
    promptSnippet: 'Control Chrome mouse movement and clicks.',
    promptGuidelines: ['Use chrome_mouse for real CDP mouse move/click actions.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      type: Type.Union([
        Type.Literal('move'),
        Type.Literal('press'),
        Type.Literal('release'),
        Type.Literal('click'),
      ]),
      x: Type.Number({ description: 'Viewport x coordinate.' }),
      y: Type.Number({ description: 'Viewport y coordinate.' }),
      button: Type.Optional(
        Type.Union([
          Type.Literal('left'),
          Type.Literal('middle'),
          Type.Literal('right'),
          Type.Literal('none'),
        ])
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const button = params.button ?? 'left';
      const move = {
        action: 'sendCommand',
        tabId: params.tabId,
        method: 'Input.dispatchMouseEvent',
        commandParams: { type: 'mouseMoved', x: params.x, y: params.y, button: 'none' },
      };
      const press = {
        action: 'sendCommand',
        tabId: params.tabId,
        method: 'Input.dispatchMouseEvent',
        commandParams: { type: 'mousePressed', x: params.x, y: params.y, button, clickCount: 1 },
      };
      const release = {
        action: 'sendCommand',
        tabId: params.tabId,
        method: 'Input.dispatchMouseEvent',
        commandParams: { type: 'mouseReleased', x: params.x, y: params.y, button, clickCount: 1 },
      };

      const actions =
        params.type === 'move' ? [move] :
        params.type === 'press' ? [press] :
        params.type === 'release' ? [release] :
        [move, press, release];

      return textResult(await chromeRequest(debuggerBatch(params.tabId, actions), signal));
    },
  });

  // ── Type Text ───────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_type_text',
    label: 'Chrome Type Text',
    description: 'Type text into the focused field in a Chrome tab via CDP.',
    promptSnippet: 'Type text into focused Chrome fields.',
    promptGuidelines: ['Use chrome_type_text only after focus is already in the intended input or editor.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      text: Type.String({ description: 'Text to insert into the focused field.' }),
      typingDelayMs: Type.Optional(Type.Number({ description: 'Delay per character in milliseconds. Defaults to 50.' })),
      sound: Type.Optional(Type.Boolean({ description: 'Whether to request typing sounds. Defaults to true.' })),
      instant: Type.Optional(Type.Boolean({ description: 'Whether to insert text instantly without delay. Defaults to false.' })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(
        await chromeRequest(
          debuggerBatch(params.tabId, [
            {
              action: 'sendCommand',
              tabId: params.tabId,
              method: 'Input.insertText',
              commandParams: {
                text: params.text,
                animateTyping: !params.instant,
                typingDelayMs: params.typingDelayMs !== undefined ? params.typingDelayMs : 50,
                sound: params.sound !== false,
              },
            },
          ]),
          signal
        )
      );
    },
  });

  // ── Batch ───────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_batch',
    label: 'Chrome Batch',
    description: 'Send multiple Chrome Controller actions in one request.',
    promptSnippet: 'Batch Chrome Controller actions in parallel or sequential mode.',
    promptGuidelines: ['Use chrome_batch for independent tab/server actions.'],
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal('parallel'), Type.Literal('sequential')])),
      stopOnError: Type.Optional(Type.Boolean()),
      actions: Type.Array(Type.Any({ description: 'Array of Chrome Controller action payloads.' })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(
        await chromeRequest(
          {
            mode: params.mode ?? 'parallel',
            stopOnError: params.stopOnError,
            actions: params.actions,
          },
          signal
        )
      );
    },
  });

  // ── Screenshot ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_screenshot',
    label: 'Chrome Screenshot',
    description: 'Capture a screenshot of a Chrome tab via CDP.',
    promptSnippet: 'Capture a screenshot of a Chrome tab.',
    promptGuidelines: ['Use chrome_screenshot when you need to inspect the visual state of a page.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      format: Type.Optional(
        Type.Union([Type.Literal('png'), Type.Literal('jpeg'), Type.Literal('webp')])
      ),
      quality: Type.Optional(Type.Number({ description: 'Compression quality 0-100.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const format = params.format ?? 'png';
      const screenshotOptions: Record<string, unknown> = { format };
      if (params.quality !== undefined) screenshotOptions['quality'] = params.quality;

      const data = await chromeRequest(
        { action: 'captureScreenshot', tabId: params.tabId, screenshotOptions },
        signal
      );

      const result = data.result as { data?: string | { data?: string }; format?: string } | undefined;
      const ext = format === 'jpeg' ? 'jpg' : format;
      const filePath = `/tmp/browser_last_screenshot_${Date.now()}.${ext}`;
      const base64Data =
        typeof result?.data === 'string' ? result.data : (result?.data as { data?: string } | undefined)?.data ?? '';
      const binary = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(filePath, binary);

      return textResult({ success: true, path: filePath });
    },
  });

  // ── Capture Video ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_capture_video',
    label: 'Chrome Capture Video',
    description: 'Capture a short video (sequence of screenshots) from a Chrome tab.',
    promptSnippet: 'Capture a short video sequence from a Chrome tab.',
    promptGuidelines: ['Use chrome_capture_video when you need to record visual changes over time.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      fps: Type.Optional(Type.Number({ description: 'Frames per second. Defaults to 5.' })),
      duration: Type.Optional(Type.Number({ description: 'Duration in seconds. Defaults to 3.' })),
      format: Type.Optional(Type.Union([Type.Literal('jpeg'), Type.Literal('png')])),
      quality: Type.Optional(Type.Number({ description: 'Quality 0-100. Defaults to 80.' })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(
        await chromeRequest(
          {
            action: 'captureVideo',
            tabId: params.tabId,
            fps: params.fps ?? 5,
            duration: params.duration ?? 3,
            format: params.format ?? 'jpeg',
            quality: params.quality ?? 80,
          },
          signal
        )
      );
    },
  });

  // ── Evaluate ────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_evaluate',
    label: 'Chrome Evaluate',
    description: 'Evaluate JavaScript on a Chrome tab page using DevTools Protocol.',
    promptSnippet: 'Evaluate custom JavaScript on a Chrome tab page.',
    promptGuidelines: ['Use chrome_evaluate to run arbitrary JS in the page context.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      expression: Type.String({ description: 'JavaScript expression to evaluate.' }),
      returnByValue: Type.Optional(Type.Boolean({ description: 'Return result by value. Defaults to true.' })),
      awaitPromise: Type.Optional(Type.Boolean({ description: 'Await promises. Defaults to true.' })),
      untruncated: Type.Optional(Type.Boolean({ description: 'Return full result without truncation.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const data = await chromeRequest(
        {
          action: 'evaluateOnPage',
          tabId: params.tabId,
          expression: params.expression,
          returnByValue: params.returnByValue !== false,
          awaitPromise: params.awaitPromise !== false,
        },
        signal
      );

      const response = data as ChromeResponse & { result?: { result?: { type?: string; value?: unknown } } };
      if (
        !params.untruncated &&
        response?.result?.result?.type === 'string' &&
        typeof response.result.result.value === 'string' &&
        response.result.result.value.length > 50000
      ) {
        response.result.result.value =
          response.result.result.value.substring(0, 50000) + '\n...[TRUNCATED. Pass untruncated:true to bypass]';
      }

      return textResult(data);
    },
  });

  // ── Extract Content ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_extract_content',
    label: 'Chrome Extract Content',
    description: 'Extract structured text content from a Chrome tab page.',
    promptSnippet: 'Extract structured page content from a Chrome tab.',
    promptGuidelines: ['Use chrome_extract_content when you need to read page text and structure.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      maxDepth: Type.Optional(Type.Number({ description: 'Max heading depth h1-h6. Defaults to 3.' })),
      maxLength: Type.Optional(Type.Number({ description: 'Max total output length. Defaults to 15000.' })),
      includeLinks: Type.Optional(Type.Boolean({ description: 'Include extracted links. Defaults to true.' })),
      includeTables: Type.Optional(Type.Boolean({ description: 'Include table data. Defaults to true.' })),
      untruncated: Type.Optional(Type.Boolean({ description: 'Return full result without truncation.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const data = await chromeRequest(
        {
          action: 'evaluateOnPage',
          tabId: params.tabId,
          expression: `(() => {
          const maxDepth = ${params.maxDepth ?? 3};
          const maxLength = ${params.untruncated ? 1000000 : (params.maxLength ?? 15000)};
          const includeLinks = ${params.includeLinks !== false};
          const includeTables = ${params.includeTables !== false};

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
        })()`,
          returnByValue: true,
          awaitPromise: true,
        },
        signal
      );

      return textResult(data);
    },
  });

  // ── Extract Regions ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_extract_regions',
    label: 'Chrome Extract Regions',
    description: 'Extract visible text regions/containers from a Chrome tab page.',
    promptSnippet: 'Extract content regions from a Chrome tab page.',
    promptGuidelines: ['Use chrome_extract_regions to find repeated content blocks.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      minTextLength: Type.Optional(Type.Number({ description: 'Min text length. Defaults to 30.' })),
      maxResults: Type.Optional(Type.Number({ description: 'Max results. Defaults to 50.' })),
      untruncated: Type.Optional(Type.Boolean({ description: 'Return full text without truncation.' })),
    }),
    async execute(_toolCallId, params, signal) {
      const minLen = params.minTextLength ?? 30;
      const maxResults = params.maxResults ?? 50;
      const maxTextLen = params.untruncated ? 5000 : 500;

      const data = await chromeRequest(
        {
          action: 'evaluateOnPage',
          tabId: params.tabId,
          expression: `(() => {
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
        })()`,
          returnByValue: true,
          awaitPromise: true,
        },
        signal
      );

      return textResult(data);
    },
  });

  // ── Console Logs ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'chrome_console_logs',
    label: 'Chrome Console Logs',
    description: 'Capture console log entries from a Chrome tab page.',
    promptSnippet: 'Obtain Chrome JS console logs from a tab page.',
    promptGuidelines: ['Use chrome_console_logs to inspect console output.'],
    parameters: Type.Object({
      tabId: Type.Number({ description: 'Chrome tab id.' }),
      timeoutMs: Type.Optional(Type.Number({ description: 'How long to collect console events.' })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(
        await chromeRequest(
          {
            action: 'getConsoleLogs',
            tabId: params.tabId,
            timeoutMs: params.timeoutMs ?? 2000,
            requestTimeoutMs: (params.timeoutMs ?? 2000) + 5000,
          },
          signal
        )
      );
    },
  });
}
