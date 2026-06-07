import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";

const DEFAULT_BASE_URL = "http://127.0.0.1:8898";
const DEFAULT_API_KEY = "B3C65095-74E1-4F48-9EBB-64F5DD6AB078";

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
};

function baseUrl() {
  return process.env.CHROME_CONTROLLER_URL || DEFAULT_BASE_URL;
}

function apiKey() {
  return process.env.CHROME_CONTROLLER_API_KEY || DEFAULT_API_KEY;
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value && typeof value === "object" ? (value as Record<string, unknown>) : { value },
  };
}

async function chromeRequest(payload: ChromeAction | Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch(baseUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
    },
    body: JSON.stringify(payload),
    signal,
  });
  const data = (await response.json()) as ChromeResponse;
  if (!response.ok && !data.success) {
    throw new Error(data.error || `Chrome Controller returned HTTP ${response.status}`);
  }
  return data;
}

async function chromeHealth(signal?: AbortSignal) {
  const response = await fetch(`${baseUrl()}/health`, { signal });
  const data = (await response.json()) as ChromeResponse;
  if (!response.ok) {
    throw new Error(data.error || `Chrome Controller health returned HTTP ${response.status}`);
  }
  return data;
}

function debuggerBatch(tabId: number, actions: ChromeAction[]) {
  return {
    mode: "sequential",
    actions: [
      { action: "ensureDebugger", tabId },
      ...actions,
    ],
  };
}

export default function chromeControllerPiExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "chrome_controller_health",
    label: "Chrome Controller Health",
    description: "Check whether the local Chrome Controller server is running and connected to the Chrome extension.",
    promptSnippet: "Check the local Chrome Controller bridge and extension connection state.",
    promptGuidelines: [
      "Use chrome_controller_health before browser-control work when connection state is unknown.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return textResult(await chromeHealth(signal));
    },
  });

  pi.registerTool({
    name: "chrome_query_tabs",
    label: "Chrome Query Tabs",
    description: "List Chrome tabs visible to the Chrome Controller extension.",
    promptSnippet: "List Chrome tabs through the local Chrome Controller bridge.",
    promptGuidelines: [
      "Use chrome_query_tabs to find the tabId before selecting, clicking, or typing into Chrome.",
      "By default, returns a short summary of tabs. Request 'full' mode only if you need all metadata."
    ],
    parameters: Type.Object({
      queryInfo: Type.Optional(Type.Any({ description: "Chrome tabs.query filter object." })),
      mode: Type.Optional(Type.Union([Type.Literal("short"), Type.Literal("full")], { description: "Response format mode. Defaults to 'short'." }))
    }),
    async execute(_toolCallId, params, signal) {
      const data = await chromeRequest({ action: "queryTabs", queryInfo: params.queryInfo || {} }, signal);
      if (params.mode !== "full" && Array.isArray(data.result)) {
        data.result = data.result.map((tab: any) => ({
          id: tab.id,
          title: tab.title,
          url: tab.url,
          active: tab.active,
          windowId: tab.windowId
        }));
      }
      return textResult(data);
    },
  });

  pi.registerTool({
    name: "chrome_create_tab",
    label: "Chrome Create Tab",
    description: "Open a URL in Chrome and mark that tab as controlled by Chrome Controller.",
    promptSnippet: "Open a Chrome tab through Chrome Controller.",
    promptGuidelines: [
      "Use chrome_create_tab when the task needs a new controlled browser tab.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to open." }),
      active: Type.Optional(Type.Boolean({ description: "Whether the new tab should become active. Defaults to true." })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: "createTab", url: params.url, active: params.active }, signal));
    },
  });

  pi.registerTool({
    name: "chrome_select_tab",
    label: "Chrome Select Tab",
    description: "Mark a Chrome tab as the controlled tab and optionally activate it.",
    promptSnippet: "Select the controlled Chrome tab.",
    promptGuidelines: [
      "Use chrome_select_tab before browser actions if a tab exists but is not yet visually marked as controlled.",
    ],
    parameters: Type.Object({
      tabId: Type.Number({ description: "Chrome tab id." }),
      activate: Type.Optional(Type.Boolean({ description: "Whether Chrome should activate the tab. Defaults to true." })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: "selectTab", tabId: params.tabId, activate: params.activate }, signal));
    },
  });

  pi.registerTool({
    name: "chrome_release_tab",
    label: "Chrome Release Tab",
    description: "Release the active Chrome Controller marker from a tab while leaving it in the AI Tool tab group.",
    promptSnippet: "Release Chrome Controller control marker from a tab.",
    promptGuidelines: [
      "Use chrome_release_tab when control is finished but the tab should stay open.",
    ],
    parameters: Type.Object({
      tabId: Type.Number({ description: "Chrome tab id." }),
      reason: Type.Optional(Type.String({ description: "Short reason shown in the page overlay action feed." })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: "releaseTab", tabId: params.tabId, reason: params.reason }, signal));
    },
  });

  pi.registerTool({
    name: "chrome_cleanup_ai_tabs",
    label: "Chrome Cleanup AI Tabs",
    description: "Release or close tabs in Chrome Controller's AI Tool tab group.",
    promptSnippet: "Clean up Chrome Controller managed tabs.",
    promptGuidelines: [
      "Use chrome_cleanup_ai_tabs with closeTabs false to clear active markers; use closeTabs true only when the user explicitly wants managed tabs closed.",
    ],
    parameters: Type.Object({
      closeTabs: Type.Optional(Type.Boolean({ description: "When true, close all tabs in the AI Tool group. Defaults to false." })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({ action: "cleanupManagedTabs", closeTabs: params.closeTabs === true }, signal));
    },
  });

  pi.registerTool({
    name: "chrome_mouse",
    label: "Chrome Mouse",
    description: "Move, press, release, or click the mouse in a Chrome tab via CDP. The Chrome extension auto-visualizes the action.",
    promptSnippet: "Control Chrome mouse movement and clicks with visible page overlay feedback.",
    promptGuidelines: [
      "Use chrome_mouse for real mouse move/click actions; do not call a separate visualizer because the extension auto-visualizes CDP mouse events.",
    ],
    parameters: Type.Object({
      tabId: Type.Number({ description: "Chrome tab id." }),
      type: Type.Union([
        Type.Literal("move"),
        Type.Literal("press"),
        Type.Literal("release"),
        Type.Literal("click"),
      ]),
      x: Type.Number({ description: "Viewport x coordinate." }),
      y: Type.Number({ description: "Viewport y coordinate." }),
      button: Type.Optional(Type.Union([
        Type.Literal("left"),
        Type.Literal("middle"),
        Type.Literal("right"),
        Type.Literal("none"),
      ])),
    }),
    async execute(_toolCallId, params, signal) {
      const button = params.button || "left";
      const move = {
        action: "sendCommand",
        tabId: params.tabId,
        method: "Input.dispatchMouseEvent",
        commandParams: { type: "mouseMoved", x: params.x, y: params.y, button: "none" },
      };
      const press = {
        action: "sendCommand",
        tabId: params.tabId,
        method: "Input.dispatchMouseEvent",
        commandParams: { type: "mousePressed", x: params.x, y: params.y, button, clickCount: 1 },
      };
      const release = {
        action: "sendCommand",
        tabId: params.tabId,
        method: "Input.dispatchMouseEvent",
        commandParams: { type: "mouseReleased", x: params.x, y: params.y, button, clickCount: 1 },
      };

      const actions =
        params.type === "move" ? [move] :
        params.type === "press" ? [press] :
        params.type === "release" ? [release] :
        [move, press, release];

      return textResult(await chromeRequest(debuggerBatch(params.tabId, actions), signal));
    },
  });

  pi.registerTool({
    name: "chrome_type_text",
    label: "Chrome Type Text",
    description: "Type text into the focused field in a Chrome tab via CDP. Characters appear one by one with optional typing sound.",
    promptSnippet: "Type text into focused Chrome fields with visible character-by-character feedback.",
    promptGuidelines: [
      "Use chrome_type_text only after focus is already in the intended input or editor.",
    ],
    parameters: Type.Object({
      tabId: Type.Number({ description: "Chrome tab id." }),
      text: Type.String({ description: "Text to insert into the focused field." }),
      typingDelayMs: Type.Optional(Type.Number({ description: "Delay per character in milliseconds. Defaults to 50." })),
      sound: Type.Optional(Type.Boolean({ description: "Whether to request typing sounds. Defaults to true." })),
      instant: Type.Optional(Type.Boolean({ description: "Whether to insert text instantly without delay. Defaults to false." })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest(debuggerBatch(params.tabId, [{
        action: "sendCommand",
        tabId: params.tabId,
        method: "Input.insertText",
        commandParams: {
          text: params.text,
          animateTyping: !params.instant,
          typingDelayMs: params.typingDelayMs !== undefined ? params.typingDelayMs : 50,
          sound: params.sound !== false,
        },
      }]), signal));
    },
  });

  pi.registerTool({
    name: "chrome_batch",
    label: "Chrome Batch",
    description: "Send multiple Chrome Controller actions in one request, either in parallel or sequential order.",
    promptSnippet: "Batch Chrome Controller actions in parallel or sequential mode.",
    promptGuidelines: [
      "Use chrome_batch for independent tab/server actions that can run together; use sequential mode for ordered mouse or text workflows.",
    ],
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("parallel"), Type.Literal("sequential")])),
      stopOnError: Type.Optional(Type.Boolean()),
      actions: Type.Array(Type.Any({ description: "Array of Chrome Controller action payloads." })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({
        mode: params.mode || "parallel",
        stopOnError: params.stopOnError,
        actions: params.actions,
      }, signal));
    },
  });

  pi.registerTool({
    name: "chrome_screenshot",
    label: "Chrome Screenshot",
    description: "Capture a screenshot of a Chrome tab via the Chrome DevTools Protocol. Returns the image directly as an attachment.",
    promptSnippet: "Capture a screenshot of a Chrome tab through Chrome Controller.",
    promptGuidelines: [
      "Use chrome_screenshot when you need to inspect the visual state of a page.",
      "The screenshot is returned as an image attachment.",
    ],
    parameters: Type.Object({
      tabId: Type.Number({ description: "Chrome tab id." }),
      format: Type.Optional(Type.Union([
        Type.Literal("png"),
        Type.Literal("jpeg"),
        Type.Literal("webp"),
      ])),
      quality: Type.Optional(Type.Number({ description: "Compression quality 0-100 (jpeg/webp only). Defaults to 100." })),
    }),
    async execute(_toolCallId, params, signal) {
      const format = params.format || "png";
      const screenshotOptions = {
        format,
        ...(params.quality !== undefined ? { quality: params.quality } : {}),
      };
      const data = await chromeRequest({
        action: "captureScreenshot",
        tabId: params.tabId,
        screenshotOptions,
      }, signal);

      const result = data.result as any;
      const ext = format === "jpeg" ? "jpg" : format;
      const filePath = `/tmp/browser_last_screenshot_${Date.now()}.${ext}`;
      const base64Data = typeof result.data === "string" ? result.data : result.data?.data;
      const binary = Buffer.from(base64Data, "base64");
      fs.writeFileSync(filePath, binary);

      return textResult({ success: true, path: filePath });
    },
  });

  pi.registerTool({
    name: "chrome_evaluate",
    label: "Chrome Evaluate",
    description: "Evaluate JavaScript on a Chrome tab page using the DevTools Protocol Runtime.evaluate.",
    promptSnippet: "Evaluate custom JavaScript on a Chrome tab page through Chrome Controller.",
    promptGuidelines: [
      "Use chrome_evaluate to run arbitrary JS in the page context and get the result.",
      "The expression is evaluated directly (not wrapped in a function).",
    ],
    parameters: Type.Object({
      tabId: Type.Number({ description: "Chrome tab id." }),
      expression: Type.String({ description: "JavaScript expression to evaluate in the page context." }),
      returnByValue: Type.Optional(Type.Boolean({ description: "Whether to return the result by value instead of by reference. Defaults to true." })),
      awaitPromise: Type.Optional(Type.Boolean({ description: "Whether to await promises returned by the expression. Defaults to true." })),
      untruncated: Type.Optional(Type.Boolean({ description: "Whether to return full string result even if very large. Defaults to false." })),
    }),
    async execute(_toolCallId, params, signal) {
      const data = await chromeRequest({
        action: "evaluateOnPage",
        tabId: params.tabId,
        expression: params.expression,
        returnByValue: params.returnByValue !== false,
        awaitPromise: params.awaitPromise !== false,
      }, signal);

      if (!params.untruncated && data && data.result && data.result.result && data.result.result.type === "string") {
        const val = data.result.result.value;
        if (typeof val === "string" && val.length > 50000) {
          data.result.result.value = val.substring(0, 50000) + "\n...[TRUNCATED. Pass untruncated:true to bypass]";
        }
      }

      return textResult(data);
    },
  });

  pi.registerTool({
    name: "chrome_console_logs",
    label: "Chrome Console Logs",
    description: "Capture console log entries from a Chrome tab page via the DevTools Protocol Runtime domain.",
    promptSnippet: "Obtain Chrome JS console logs from a tab page through Chrome Controller.",
    promptGuidelines: [
      "Use chrome_console_logs to inspect console output (log, warn, error) from a page.",
      "Logs are collected for a short window (default 2 seconds). Use timeoutMs to extend.",
    ],
    parameters: Type.Object({
      tabId: Type.Number({ description: "Chrome tab id." }),
      timeoutMs: Type.Optional(Type.Number({ description: "How long (ms) to collect console events. Defaults to 2000." })),
    }),
    async execute(_toolCallId, params, signal) {
      return textResult(await chromeRequest({
        action: "getConsoleLogs",
        tabId: params.tabId,
        timeoutMs: params.timeoutMs || 2000,
      }, signal));
    },
  });
}
