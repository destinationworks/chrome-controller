---
name: chrome-controller
description: Use Chrome Controller from Pi to inspect tabs, open/select a controlled tab, move/click the mouse, insert text, capture screenshots, record short video captures, evaluate JavaScript, read console logs, and batch multiple Chrome actions through the local extension bridge.
---

# Chrome Controller

Use this skill when the user asks you to control Chrome, inspect browser tabs, click or type in a page, capture screenshots, evaluate JavaScript, read console logs, or run browser actions through the local Chrome Controller extension.

## Required Components

1. **Chrome Extension** — load `Chrome Extension/` as an unpacked MV3 extension in Chrome.
2. **Bridge Server** — `cd /path/to/chrome-controller && npm start` (kills stale server, rebuilds, starts & verifies healthy).
3. **Pi/Antigravity Extension** — registered via `settings.json`.

## Install

### Pi

Add to `~/.pi/agent/settings.json`:

```json
{"packages": ["/path/to/chrome-controller"]}
```

Restart Pi. The `chrome-controller` skill and all `chrome_*` tools load automatically.

### Antigravity (MCP)

Add to `settings.json` or Claude Desktop config:

```json
{
  "mcpServers": {
    "chrome-controller": {
      "command": "node",
      "args": ["/path/to/chrome-controller/dist/mcp.js"],
      "env": {"HTTP_PORT": "8898", "API_KEY": "B3C65095-..."}
    }
  }
}
```

### Environment Variables

| Variable                    | Default                 | Description                     |
| --------------------------- | ----------------------- | ------------------------------- |
| `HTTP_PORT`                 | `8898`                  | HTTP API port                   |
| `WS_PORT`                   | `8899`                  | WebSocket port                  |
| `API_KEY`                   | `B3C65095-...`          | Auth key                        |
| `CHROME_CONTROLLER_URL`     | `http://127.0.0.1:8898` | Pi extension: relay base URL    |
| `CHROME_CONTROLLER_API_KEY` | _(same as API_KEY)_     | Pi extension: auth key          |

## Workflow

1. **Pre-flight:** Run `npm start`, then `chrome_controller_health` to confirm connection.
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

| Action               | Key Params                              | Notes                                  |
| -------------------- | --------------------------------------- | -------------------------------------- |
| `createTab`          | `url`, `active`                         | Creates and selects tab                |
| `queryTabs`          | `queryInfo`                             | Query tabs                             |
| `selectTab`          | `tabId`, `activate`                     | Mark tab as controlled                 |
| `releaseTab`         | `tabId`, `reason`                       | Release control, keep tab open         |
| `captureScreenshot`  | `tabId`, `screenshotOptions`            | PNG/JPEG/WebP via CDP                  |
| `captureVideo`       | `tabId`, `fps`, `duration`, `format`    | CDP screenshot sequence                |
| `evaluateOnPage`     | `tabId`, `expression`, `awaitPromise`   | `Runtime.evaluate` via CDP             |
| `getConsoleLogs`     | `tabId`, `timeoutMs`                    | Collect `consoleAPICalled` events      |
| `sendCommand`        | `tabId`, `method`, `commandParams`      | Raw CDP command                        |
| `ensureDebugger`     | `tabId`                                 | Attach debugger (idempotent)           |
| `visualizeAction`    | `tabId`, `type`, `x`, `y`, `detail`    | HUD overlay effect                     |
| `cleanupManagedTabs` | `closeTabs`                             | Release or close AI-managed tabs       |
| `batch`              | `actions`, `mode`                       | Nested batch                           |

```json
{"mode": "parallel", "actions": [{"action": "queryTabs"}, {"action": "evaluateOnPage", "tabId": 123, "expression": "1+1"}]}
```

## Notes

- Coordinates are viewport coordinates in the target tab.
- Restricted pages (`chrome://`) may not show the visual overlay.
- The extension auto-visualizes CDP mouse and text commands; do not call visual-only actions separately.
