---
name: chrome-controller
description: Use Chrome Controller from Pi to inspect tabs, open/select a controlled tab, move/click the mouse, insert text, capture screenshots, record short video captures, evaluate JavaScript, read console logs, and batch multiple Chrome actions through the local extension bridge.
---

# Chrome Controller

Use this skill when the user asks you to control Chrome, inspect browser tabs, click or type in a page, capture screenshots, evaluate JavaScript, read console logs, or run browser actions through the local Chrome Controller extension.

## Required Components

1. **Chrome Extension** — load `Chrome Extension/` as an unpacked MV3 extension in Chrome.
2. **Native Messaging Host (Primary — Zero Ports)** — register host via `npm run install-host <EXTENSION_ID>`. Chrome and MCP connect automatically over stdio / Unix IPC (`/tmp/chrome-controller.sock`) with zero open network ports.
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
| `API_KEY`                   | `B3C65095-...`          | Fallback Auth key (relay mode only)          |
| `CHROME_CONTROLLER_URL`     | `http://127.0.0.1:8898` | Pi fallback: relay base URL                  |
| `CHROME_CONTROLLER_API_KEY` | _(same as API_KEY)_     | Pi fallback: auth key                        |

## Workflow

1. **Pre-flight:** Run `chrome_controller_health` to confirm connection over Native Messaging (do NOT run `npm start`). If health fails, notify the user before attempting fallback options.
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
| `batch`              | `actions`, `mode`                     | Nested batch                      |

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
- The extension auto-visualizes CDP mouse and text commands; do not call visual-only actions separately.
