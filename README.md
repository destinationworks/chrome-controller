# Chrome Controller

A local Chrome control bridge for AI agents, with:

- **`Chrome Extension/`** — MV3 Chrome extension (WebSocket client + CDP overlay HUD)
- **`src/server.ts`** — WebSocket/HTTP relay server (compiled to `dist/server.js`)
- **`src/mcp.ts`** — MCP stdio server (compiled to `dist/mcp.js`)
- **`src/index.ts`** — Pi / Antigravity extension entry point

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start the relay server (automated)

```bash
npm start
```

This single command handles everything: kills stale servers, rebuilds if source changed, starts the server, and waits until it's healthy. The HTTP API listens on `http://127.0.0.1:8898` and the WebSocket on `ws://127.0.0.1:8899` by default.

### 3. Load the Chrome extension

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `Chrome Extension/` folder.

Once connected, you'll see `Chrome extension connected!` in the server terminal.

## Environment Variables

| Variable             | Default                                | Description                   |
| -------------------- | -------------------------------------- | ----------------------------- |
| `HTTP_PORT`          | `8898`                                 | HTTP API port                 |
| `WS_PORT`            | `8899`                                 | WebSocket port                |
| `API_KEY`            | `B3C65095-74E1-4F48-9EBB-64F5DD6AB078` | Auth key                      |
| `REQUEST_TIMEOUT_MS` | `10000`                                | Per-command timeout           |
| `MAX_BATCH_ACTIONS`  | `50`                                   | Max actions per batch request |

## Pi Extension Setup

Add the repo root to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/path/to/chrome-controller"]
}
```

Restart Pi. The `chrome-controller` skill and all `chrome_*` tools load automatically.

## MCP Server Setup

Add to your Antigravity / Claude Desktop config:

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

> **Note:** The relay server (`npm start`) must be running separately. The MCP server only proxies tool calls to it.

## Usage Examples

### Health Check

```bash
curl http://127.0.0.1:8898/health
```

### Single Action

```bash
curl -X POST http://127.0.0.1:8898 \
  -H "Content-Type: application/json" \
  -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
  -d '{"action":"queryTabs"}'
```

### Batch Actions (parallel)

```bash
curl -X POST http://127.0.0.1:8898 \
  -H "Content-Type: application/json" \
  -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
  -d '{"mode":"parallel","actions":[{"action":"queryTabs"},{"action":"createTab","url":"https://example.com"}]}'
```

### Sequential mouse click via CDP

```bash
curl -X POST http://127.0.0.1:8898 \
  -H "Content-Type: application/json" \
  -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
  -d '{
    "mode": "sequential",
    "actions": [
      {"action": "ensureDebugger", "tabId": 123},
      {"action": "sendCommand", "tabId": 123, "method": "Input.dispatchMouseEvent",
       "commandParams": {"type": "mousePressed", "x": 200, "y": 160, "button": "left", "clickCount": 1}}
    ]
  }'
```

## Running Tests

```bash
npm test
```

Tests cover the HTTP/WebSocket relay server (with a mock extension client) and the Pi extension tool logic.

## Managed Tab Visibility

Every controlled tab is moved into a visible Chrome tab group named **AI Tool**. While actively controlled, the page title is prefixed with `🤖 ` and the in-page HUD shows the current action, coordinates, and recent activity.

Release markers but keep managed tabs open:

```bash
curl -X POST http://127.0.0.1:8898 \
  -H "Content-Type: application/json" \
  -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
  -d '{"action":"cleanupManagedTabs"}'
```

Close all tabs in the AI Tool group:

```bash
curl -X POST http://127.0.0.1:8898 \
  -H "Content-Type: application/json" \
  -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
  -d '{"action":"cleanupManagedTabs","closeTabs":true}'
```
