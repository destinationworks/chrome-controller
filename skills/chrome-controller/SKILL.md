---
name: chrome-controller
description: Use Chrome Controller from Pi to inspect tabs, open/select a controlled tab, move/click the mouse, insert text, capture screenshots, record short video captures, evaluate JavaScript, read console logs, and batch multiple Chrome actions through the local extension bridge.
---

# Chrome Controller

Use this skill when the user asks you to control Chrome, inspect browser tabs, click or type in a page, capture screenshots, evaluate JavaScript, read console logs, or run browser actions through the local Chrome Controller extension.

> [!IMPORTANT]
> **Primary Recommendation for Browser-Only Tasks**:
> Whenever an operation only requires interacting with Google Chrome or web pages (e.g. navigation, clicking DOM elements, form input, scraping, page screenshots, evaluating JS), **ALWAYS prefer and use `chrome-controller`** rather than OS-level automation (`computer-controller`).
> 
> **Why:**
> - `chrome-controller` acts directly at the browser/CDP level inside a dedicated AI tab group (`🤖 AI Tool`).
> - It does NOT hijack or move the user's physical mouse cursor, steal OS window focus, or emit global system keyboard events.
> - This completely eliminates race conditions and input conflicts with the real human user actively using the desktop, as well as conflicts with other background tasks.

## Required Components

1. **Chrome Extension** — load `Chrome Extension/` as an unpacked MV3 extension in Chrome.
0. **Hanging tools?** Run `npm run watchdog`. A wedged host keeps its socket bound and answers
   nothing, so commands hang instead of failing; `npm run watchdog -- --recover` clears it, then
   re-enable the extension at `chrome://extensions`. A failed tool call is not proof the host died:
   confirm with `npm run watchdog` before saying so.
2. **Native Messaging Host (Primary — Zero Ports)** — register host via `npm run install-host <EXTENSION_ID>`. Chrome and MCP connect automatically over stdio / Unix IPC (`~/.chrome-controller/run/chrome-controller.sock`, or `$XDG_RUNTIME_DIR/chrome-controller/run.sock` when set) with zero open network ports.
3. **Pi/Antigravity Extension / MCP** — registered via `settings.json` or `mcpServers`.
4. **Standalone Relay Server (Fallback Only)** — `npm start` (opens HTTP/WS ports). **STRICTLY RESTRICTED**: Ports may ONLY be used when Native Messaging fails, and requires explicit user notification.

## Install

### Native Messaging (Primary — Zero Ports)

Register the native messaging host for the active extension:

```bash
npm run install-host <EXTENSION_ID>
# E.g. for Chrome Web Store: npm run install-host gocbenlgkgeaiifofilndbnaeigpplca
```

### Antigravity (MCP)

Add to `settings.json` or MCP configuration:

```json
{
  "mcpServers": {
    "chrome-controller": {
      "command": "node",
      "args": ["/path/to/chrome-controller/dist/mcp.js"]
    }
  }
}
```

No port or API key environment variables are required when using Native Messaging.

### Fallback Policy: Port-Based Standalone Relay

> [!IMPORTANT]
> **Zero-Ports Policy**: Do NOT start or use HTTP (`8898`) or WebSocket (`8899`) servers by default.
> Network ports are ONLY permitted if the Native Messaging protocol fails.
> **User Notification Required**: When falling back to port-based relay (`npm start`), you MUST explicitly notify the user that Native Messaging failed and network ports are being used as a temporary fallback.

| Variable                    | Default                 | Description                                  |
| --------------------------- | ----------------------- | -------------------------------------------- |
| `HTTP_PORT`                 | `8898`                  | Fallback HTTP API port (relay mode only)     |
| `WS_PORT`                   | `8899`                  | Fallback WebSocket port (relay mode only)    |
| `API_KEY`                   | random per instance     | Optional explicit relay key, minimum 32 bytes |
| `CHROME_CONTROLLER_URL`     | private discovery       | Pi fallback: loopback relay base URL only    |
| `CHROME_CONTROLLER_API_KEY` | private discovery       | Pi fallback: paired/discovered auth key      |

Relay credentials are generated per server instance, saved in a `0600` discovery file inside a `0700` directory, and paired to the extension over Native Messaging. Never copy a relay key into source, prompts, logs, or command history. A cold extension session without a native pairing must fail closed.

## Workflow

1. **Pre-flight:** Run `chrome_controller_health` to confirm connection over Native Messaging (do NOT run `npm start`). If health fails, notify the user before attempting fallback options. Only `NATIVE_IPC_UNAVAILABLE` means the host could not be reached. `NATIVE_IPC_TIMEOUT` or `NATIVE_IPC_PROTOCOL_ERROR` mean the host received the command and may have run it, so check the page before repeating a click, fill, or tab creation. Health with `mode: "NativeMessagingIPC"` and `success: false` means the host is up but refused a Chrome query; `error`, `extensionConnected`, `sensitiveExtractionInProgress`, and `browserOutputQuarantined` say why.
2. **Find or create a tab:** `chrome_query_tabs` or `chrome_create_tab`.
3. **Select a tab:** `chrome_select_tab` to mark an existing tab as controlled.
4. Controlled tabs go into the **AI Tool** Chrome tab group and get a `🤖 ` title prefix.
5. **Mouse:** `chrome_mouse` for viewport mouse actions (auto-visualized).
6. **Text:** `chrome_type_text` after the target input is focused. Uses `typingDelayMs: 55-100` for demos.
7. **Screenshot:** `chrome_screenshot` returns a `/tmp/` path; use `read` to inspect.
8. **Video:** `chrome_capture_video` with `fps`, `duration`, `format`, `quality`.
9. **JavaScript:** `chrome_evaluate` to run arbitrary JS in the page context.
10. **Content extraction:** `chrome_extract_content` for structured text; `chrome_extract_regions` for repeated blocks (listings, results, cards).
11. **Console logs:** `chrome_console_logs` for `log`, `warn`, `error` output.
12. **Release control:** `chrome_release_tab` when done (keeps tab open).
13. **Cleanup:** `chrome_cleanup_ai_tabs` to release markers; add `closeTabs: true` only when explicitly requested.
14. **Batch:** `chrome_batch` with `mode: "parallel"` (default) or `mode: "sequential"`. Each action needs an `action` field (see table below).

## Batch Action Names

| Action               | Key Params                            | Notes                             |
| -------------------- | ------------------------------------- | --------------------------------- |
| `createTab`          | `url`, `active`                       | Creates and selects tab           |
| `queryTabs`          | `queryInfo`                           | Query tabs                        |
| `selectTab`          | `tabId`, `activate`                   | Mark tab as controlled            |
| `releaseTab`         | `tabId`, `reason`                     | Release control, keep tab open    |
| `captureScreenshot`  | `tabId`, `screenshotOptions`          | PNG/JPEG/WebP via CDP             |
| `captureVideo`       | `tabId`, `fps`, `duration`, `format`  | CDP screenshot sequence           |
| `evaluateOnPage`     | `tabId`, `expression`, `awaitPromise` | `Runtime.evaluate` via CDP        |
| `getConsoleLogs`     | `tabId`, `timeoutMs`                  | Collect `consoleAPICalled` events |
| `sendCommand`        | `tabId`, `method`, `commandParams`    | Raw CDP command                   |
| `ensureDebugger`     | `tabId`                               | Attach debugger (idempotent)      |
| `visualizeAction`    | `tabId`, `type`, `x`, `y`, `detail`   | HUD overlay effect                |
| `cleanupManagedTabs` | `closeTabs`                           | Release or close AI-managed tabs  |
| `setOverlayHidden`   | `hidden`                              | Hide or show the HUD overlay      |
| `getOverlayState`    |                                       | Overlay and controlled-tab state  |

A raw batch request names `action: "batch"` and puts its items in one array, `actions` or `commands`, never both. A request whose item list is missing or not an array is refused, and so is any other action that carries `actions` or `commands`. A batch item cannot itself be a `batch`.

```json
{
  "mode": "parallel",
  "actions": [
    { "action": "queryTabs" },
    { "action": "evaluateOnPage", "tabId": 123, "expression": "1+1" }
  ]
}
```

## Notes

- Coordinates are viewport coordinates in the target tab.
- Restricted pages (`chrome://`) may not show the visual overlay.
- **Secrets:** Do not pass passwords, tokens, recovery material, or other secrets to `chrome_fill` or animated `chrome_type_text`. The current content script echoes inserted text into its in-page action feed, and `chrome_fill` returns the text in its result. Prefer the site's/password manager's own autofill flow. Otherwise stop and implement a secret-safe path that neither renders nor returns the value. Reload the target page immediately if a secret is ever inserted through the unsafe path.
- If `chrome_evaluate` or another CDP-backed action fails with `Cannot access a chrome-extension:// URL of different extension`, do not treat that alone as a Native Messaging outage and do not enable the network relay. Re-run `chrome_controller_health`, then use the content-script path (`chrome_snapshot_elements`, `chrome_click`, and `chrome_get_page_errors`) when those calls still succeed. Use `chrome_fill` only for non-secret text. This can occur when another extension owns the debugger or page attachment even though ordinary tab-scoped controls remain safe and functional.
- The extension auto-visualizes CDP mouse and text commands; do not call visual-only actions separately.
