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

      const response = data as any;
      if (!params.untruncated && response && response.result && response.result.result && response.result.result.type === "string") {
        const val = response.result.result.value;
        if (typeof val === "string" && val.length > 50000) {
          response.result.result.value = val.substring(0, 50000) + "\n...[TRUNCATED. Pass untruncated:true to bypass]";
        }
      }

      return textResult(data);
    },
  });

  pi.registerTool({
    name: "chrome_extract_content",
    label: "Chrome Extract Content",
    description: "Extract structured text content from a Chrome tab page (headings, paragraphs, links, tables, lists). Returns organized sections without requiring manual CSS selectors.",
    promptSnippet: "Extract structured page content from a Chrome tab automatically.",
    promptGuidelines: [
      "Use chrome_extract_content instead of chrome_evaluate when you need to read page content (headings, body text, links, tables).",
      "Prefer this over manual DOM queries for general content extraction — it handles SPAs, server-rendered pages, and dynamic content.",
      "Use maxDepth to limit heading hierarchy (default 3) and maxLength to cap output size.",
    ],
    parameters: Type.Object({
      tabId: Type.Number({ description: "Chrome tab id." }),
      maxDepth: Type.Optional(Type.Number({ description: "Maximum heading depth to extract (h1-h6). Defaults to 3." })),
      maxLength: Type.Optional(Type.Number({ description: "Maximum total output length in characters. Defaults to 15000." })),
      includeLinks: Type.Optional(Type.Boolean({ description: "Whether to include extracted links. Defaults to true." })),
      includeTables: Type.Optional(Type.Boolean({ description: "Whether to include table data. Defaults to true." })),
      untruncated: Type.Optional(Type.Boolean({ description: "Whether to return full result even if very large. Defaults to false." })),
    }),
    async execute(_toolCallId, params, signal) {
      const data = await chromeRequest({
        action: "evaluateOnPage",
        tabId: params.tabId,
        expression: `(() => {
          const maxDepth = ${params.maxDepth || 3};
          const maxLength = ${params.untruncated ? 1000000 : (params.maxLength || 15000)};
          const includeLinks = ${params.includeLinks !== false};
          const includeTables = ${params.includeTables !== false};

          const result = { headings: [], sections: [], links: [], tables: [] };
          let totalLen = 0;

          // Extract headings
          const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
          headings.forEach(h => {
            const level = parseInt(h.tagName[1]);
            if (level <= maxDepth && h.offsetParent) {
              result.headings.push({ level, text: h.innerText.trim().substring(0, 200) });
              totalLen += h.innerText.length;
            }
          });

          // Extract visible paragraphs and text blocks
          const textBlocks = [];
          const blockSelectors = 'p, li, blockquote, dt, dd, figcaption, td, th, .content, .text, .description';
          document.querySelectorAll(blockSelectors).forEach(el => {
            if (el.offsetParent && !el.closest('script, style, noscript, .chrome-controller-overlay-root')) {
              const text = el.innerText.trim();
              if (text.length > 10) textBlocks.push(text);
            }
          });

          // Deduplicate and group into sections
          const seen = new Set();
          textBlocks.forEach(text => {
            const key = text.substring(0, 50);
            if (!seen.has(key) && text.length <= 500) {
              seen.add(key);
              result.sections.push(text.substring(0, 500));
              totalLen += text.length;
            }
          });

          // Extract links
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

          // Extract tables
          if (includeTables) {
            document.querySelectorAll('table').forEach(t => {
              if (t.offsetParent) {
                const rows = [];
                t.querySelectorAll('tr').forEach(tr => {
                  const cells = [];
                  tr.querySelectorAll('td, th').forEach(cell => {
                    cells.push(cell.innerText.trim().substring(0, 200));
                  });
                  if (cells.length > 0) rows.push(cells);
                  if (rows.length >= 20) return;
                });
                if (rows.length > 0 && rows.length <= 50) {
                  result.tables.push(rows);
                  totalLen += rows.length * 100;
                }
              }
            });
          }

          // Truncate if over maxLength
          if (totalLen > maxLength) {
            result.sections = result.sections.filter(s => s.length < 200);
            result.links = result.links.slice(0, 10);
          }

          return result;
        })()`,
        returnByValue: true,
        awaitPromise: true,
      }, signal);

      if (!params.untruncated && data && (data as ChromeResponse).result) {
        const res = (data as ChromeResponse).result as { headings: any[]; sections: any[]; links: any[]; tables: any[][] };
        if (res && typeof res === 'object') {
          const estLen = JSON.stringify(res).length;
          if (estLen > 50000) {
            if (res.sections) res.sections = res.sections.slice(0, 5);
            if (res.links) res.links = res.links.slice(0, 10);
            if (res.tables) res.tables = res.tables.slice(0, 2);
            (data as ChromeResponse).result = res;
          }
        }
      }

      return textResult(data);
    },
  });

  pi.registerTool({
    name: "chrome_extract_regions",
    label: "Chrome Extract Regions",
    description: "Extract visible text regions/containers from a Chrome tab page. Useful for listing job cards, product items, search results, or any repeated content blocks.",
    promptSnippet: "Extract all visible content regions from a Chrome tab page.",
    promptGuidelines: [
      "Use chrome_extract_regions to find repeated content blocks (job listings, search results, product cards) without knowing CSS selectors.",
      "Returns regions with their class, text content, and any links inside.",
      "Use maxResults to limit output when pages have many elements.",
    ],
    parameters: Type.Object({
      tabId: Type.Number({ description: "Chrome tab id." }),
      minTextLength: Type.Optional(Type.Number({ description: "Minimum text length to include a region. Defaults to 30." })),
      maxResults: Type.Optional(Type.Number({ description: "Maximum number of regions to return. Defaults to 50." })),
      untruncated: Type.Optional(Type.Boolean({ description: "Whether to return full text even if very large. Defaults to false." })),
    }),
    async execute(_toolCallId, params, signal) {
      const minLen = params.minTextLength || 30;
      const maxResults = params.maxResults || 50;
      const maxTextLen = params.untruncated ? 5000 : 500;

      const data = await chromeRequest({
        action: "evaluateOnPage",
        tabId: params.tabId,
        expression: `(() => {
          const regions = [];
          const seen = new Set();

          // Find card-like containers
          const selectors = [
            '[class*="card"], [class*="item"], [class*="result"], [class*="post"],
            [class*="listing"], [class*="entry"], [class*="job"], [class*="vacancy"],
            [class*="product"], [class*="review"], [class*="comment"], [class*="article"]
          ].join(',');

          document.querySelectorAll(selectors).forEach(el => {
            if (!el.offsetParent) return;
            if (el.closest('.chrome-controller-overlay-root')) return;

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

            regions.push({
              class: cls,
              text: text.substring(0, ${maxTextLen}),
              links: links.slice(0, 3)
            });

            if (regions.length >= ${maxResults}) return;
          });

          // Also try common structural blocks
          if (regions.length < 5) {
            document.querySelectorAll('section, article, main, .container, .wrapper, div[class*="body"], div[class*="content"]').forEach(el => {
              if (!el.offsetParent || el.closest('.chrome-controller-overlay-root')) return;
              const text = el.innerText.trim();
              if (text.length < ${minLen}) return;
              const cls = typeof el.className === 'string' ? el.className : '';
              const key = cls + ':' + text.substring(0, 40);
              if (seen.has(key)) return;
              seen.add(key);

              regions.push({
                class: cls,
                text: text.substring(0, ${maxTextLen}),
                links: []
              });
              if (regions.length >= ${maxResults}) return;
            });
          }

          return regions;
        })()`,
        returnByValue: true,
        awaitPromise: true,
      }, signal);

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
        requestTimeoutMs: (params.timeoutMs || 2000) + 5000,
      }, signal));
    },
  });
}
