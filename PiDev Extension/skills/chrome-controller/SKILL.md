---
name: chrome-controller
description: Use Chrome Controller from Pi to inspect tabs, open/select a controlled tab, move/click the mouse, insert text, capture screenshots, evaluate JavaScript, read console logs, and batch multiple Chrome actions through the local extension bridge.
---

# Chrome Controller

Use this skill when the user asks Pi to control Chrome, inspect browser tabs, click or type in a page, capture screenshots, evaluate JavaScript, read console logs, or run several browser actions through the local Chrome Controller extension.

## Required Runtime

- Local server: `cd server && npm start`
- Chrome extension: load the repo's `Chrome Extension` folder as an unpacked extension.
- Pi extension: run with `pi -e "./PiDev Extension"` or install this folder as a Pi package.

## Workflow

1. Call `chrome_controller_health` first if connection state is unknown.
2. Call `chrome_query_tabs` to find a `tabId`, or `chrome_create_tab` to open a controlled tab.
3. Call `chrome_select_tab` when an existing tab should be visually marked as controlled.
4. Controlled tabs are placed into the visible Chrome tab group `AI Tool` and get a robot title marker while actively controlled.
5. Use `chrome_mouse` for real viewport mouse actions. It auto-visualizes move, press, release, and click on the page.
6. Use `chrome_type_text` only after the target input/editor is focused. It types characters one by one with visible feedback and optional typing sound.
7. Use `chrome_screenshot` to capture a tab screenshot. Returns the image directly as an attachment.
8. Use `chrome_evaluate` to run arbitrary JavaScript in the page context.
9. Use `chrome_console_logs` to collect console output (log, warn, error) from a page.
10. Use `chrome_release_tab` when control is finished but the tab should remain open.
11. Use `chrome_cleanup_ai_tabs` to release active markers, or with `closeTabs: true` only when the user explicitly wants to close managed tabs.
12. Use `chrome_batch` for multiple independent actions in parallel; use `mode: "sequential"` for ordered flows. Each action in the `actions` array must have an `action` field with the server-side action name (see table below), not the MCP tool name.

## Batch Action Names

Use these action names in `chrome_batch` `actions` arrays:

| Action | Key Params | Notes |
|---|---|---|
| `createTab` | `url`, `active` | Creates and selects tab |
| `queryTabs` | `queryInfo` | Query tabs (same as `chrome.tabs.query`) |
| `selectTab` | `tabId`, `activate` | Mark tab as controlled |
| `releaseTab` | `tabId`, `reason` | Release control, keep tab open |
| `screenshot` | `tabId`, `screenshotOptions` | PNG/JPEG screenshot via CDP |
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
