---
name: chrome-controller
description: Use Chrome Controller from Pi to inspect tabs, open/select a controlled tab, move/click the mouse, insert text, capture screenshots, record short video captures, evaluate JavaScript, read console logs, and batch multiple Chrome actions through the local extension bridge.
---

# Chrome Controller

Use this skill when the user asks you to control Chrome, inspect browser tabs, click or type in a page, capture screenshots, evaluate JavaScript, read console logs, or run several browser actions through the local Chrome Controller extension.

## Required Components

Chrome Controller has three parts that must all be running:

1. **Chrome Extension** — load the `Chrome Extension/` folder as an unpacked MV3 extension in Chrome.
2. **Bridge Server** — the local WebSocket/HTTP relay:
   ```bash
   cd /path/to/chrome-controller
   npm install && npm run build
   npm start   # or: node dist/server.js
   ```
3. **Pi/Antigravity Extension** — registered automatically via `settings.json` (see Install section).

## Install

### Pi

Add the repo path to `~/.pi/agent/settings.json`:
```json
{
  "packages": ["/path/to/chrome-controller"]
}
```

Then restart Pi. The `chrome-controller` skill and all `chrome_*` tools load automatically.

### Antigravity (MCP)

Add to your Antigravity `settings.json` or Claude Desktop config:
```json
{
  "mcpServers": {
    "chrome-controller": {
      "command": "node",
      "args": ["/path/to/chrome-controller/dist/mcp.js"],
      "env": {
        "HTTP_PORT": "8898",
        "API_KEY": "B3C65095-74E1-4F48-9EBB-64F5DD6AB078"
      }
    }
  }
}
```

The MCP server proxies all tool calls to the bridge server over HTTP.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HTTP_PORT` | `8898` | HTTP API port |
| `WS_PORT` | `8899` | WebSocket port (extension connects here) |
| `API_KEY` | `B3C65095-...` | Auth key for HTTP API |
| `CHROME_CONTROLLER_URL` | `http://127.0.0.1:8898` | Pi extension: relay base URL |
| `CHROME_CONTROLLER_API_KEY` | *(same as API_KEY)* | Pi extension: auth key |

## Workflow

1. Call `chrome_controller_health` first if connection state is unknown.
2. Call `chrome_query_tabs` to find a `tabId`, or `chrome_create_tab` to open a controlled tab.
3. Call `chrome_select_tab` when an existing tab should be visually marked as controlled.
4. Controlled tabs are placed into the visible Chrome tab group **AI Tool** and get a robot title marker while actively controlled.
5. Use `chrome_mouse` for real viewport mouse actions. It auto-visualizes move, press, release, and click on the page.
6. Use `chrome_type_text` only after the target input/editor is focused. It types characters one by one with visible feedback and optional typing sound.
7. Use `chrome_screenshot` to capture a tab screenshot. Returns a file path in `/tmp/`. Use the `read` tool on the returned `path` value to inspect it.
8. Use `chrome_capture_video` to record a short sequence of screenshots (video capture). Specify `fps`, `duration`, `format`, and `quality`.
9. Use `chrome_evaluate` to run arbitrary JavaScript in the page context.
10. Use `chrome_extract_content` to extract structured page text (headings, paragraphs, links, tables) without writing custom JS.
11. Use `chrome_extract_regions` to find repeated content blocks (job listings, search results, product cards).
12. Use `chrome_console_logs` to collect console output (log, warn, error) from a page.
13. Use `chrome_release_tab` when control is finished but the tab should remain open.
14. Use `chrome_cleanup_ai_tabs` to release active markers, or with `closeTabs: true` only when the user explicitly wants to close managed tabs.
15. Use `chrome_batch` for multiple independent actions in parallel; use `mode: "sequential"` for ordered flows. Each action in the `actions` array must have an `action` field with the server-side action name (see table below).

## Batch Action Names

Use these action names in `chrome_batch` `actions` arrays:

| Action | Key Params | Notes |
|---|---|---|
| `createTab` | `url`, `active` | Creates and selects tab |
| `queryTabs` | `queryInfo` | Query tabs (same as `chrome.tabs.query`) |
| `selectTab` | `tabId`, `activate` | Mark tab as controlled |
| `releaseTab` | `tabId`, `reason` | Release control, keep tab open |
| `captureScreenshot` | `tabId`, `screenshotOptions` | PNG/JPEG/WebP screenshot via CDP |
| `captureVideo` | `tabId`, `fps`, `duration`, `format`, `quality` | Sequence of CDP screenshots at specified FPS |
| `evaluateOnPage` | `tabId`, `expression`, `returnByValue`, `awaitPromise` | `Runtime.evaluate` via CDP |
| `getConsoleLogs` | `tabId`, `timeoutMs` | Collect `Runtime.consoleAPICalled` events |
| `sendCommand` | `tabId`, `method`, `commandParams` | Raw CDP command |
| `ensureDebugger` | `tabId` | Attach debugger (idempotent) |
| `visualizeAction` | `tabId`, `type`, `x`, `y`, `detail` | Trigger HUD overlay effect |
| `cleanupManagedTabs` | `closeTabs` | Release or close AI-managed tabs |
| `batch` | `actions`, `mode` | Nested batch |

Example:
```json
{
  "mode": "parallel",
  "actions": [
    {"action": "queryTabs"},
    {"action": "evaluateOnPage", "tabId": 123, "expression": "1+1"}
  ]
}
```

## Notes

- Coordinates are viewport coordinates in the target tab.
- Restricted pages such as `chrome://` may not show the visual overlay because content scripts cannot run there.
- Do not call visual-only actions for normal mouse or typing work; the extension auto-visualizes CDP mouse and text commands.
- For human-visible demos, prefer `chrome_type_text` with `typingDelayMs` between 55 and 100 so the user can see each character appear.
