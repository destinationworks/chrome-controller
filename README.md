# Chrome Controller

A local Chrome control bridge for AI agents.

- **`Chrome Extension/`** — MV3 Chrome extension (WebSocket client + CDP overlay HUD)
- **`src/server.ts`** — WebSocket/HTTP relay server (compiled to `dist/server.js`)
- **`src/mcp.ts`** — MCP stdio server (compiled to `dist/mcp.js`)
- **`src/index.ts`** — Pi / Antigravity extension entry point

## Quick Start

1. **Install:** `npm install`
2. **Start the relay server:** `npm start`

   This single command handles everything: kills stale servers, rebuilds if source changed, starts the server, and verifies it's healthy. HTTP API on `http://127.0.0.1:8898`, WebSocket on `ws://127.0.0.1:8899`.

3. **Load the Chrome extension:** Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select `Chrome Extension/`.

   You'll see `Chrome extension connected!` in the server terminal.

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

> The relay server (`npm start`) must be running separately. The MCP server only proxies tool calls to it.

## Usage

### Health Check

```bash
curl http://127.0.0.1:8898/health
```

### Batch Actions

```bash
curl -X POST http://127.0.0.1:8898 \
  -H "Content-Type: application/json" \
  -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
  -d '{"mode":"parallel","actions":[{"action":"queryTabs"},{"action":"createTab","url":"https://example.com"}]}'
```

For raw CDP commands (e.g. mouse click), use `ensureDebugger` followed by `sendCommand`:

```bash
curl -X POST http://127.0.0.1:8898 \
  -H "Content-Type: application/json" \
  -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
  -d '{"mode":"sequential","actions":[{"action":"ensureDebugger","tabId":123},{"action":"sendCommand","tabId":123,"method":"Input.dispatchMouseEvent","commandParams":{"type":"mousePressed","x":200,"y":160,"button":"left","clickCount":1}}]}'
```

## Tests

```bash
npm test
```

Tests cover the HTTP/WebSocket relay server (with a mock extension client) and the Pi extension tool logic.

## Managed Tab Visibility

Every controlled tab is moved into a visible Chrome tab group named **AI Tool**. While actively controlled, the page title is prefixed with `🤖 ` and the in-page HUD shows the current action, coordinates, and recent activity.

Release markers but keep managed tabs open:

```bash
curl -X POST http://127.0.0.1:8898 -H "Content-Type: application/json" -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" -d '{"action":"cleanupManagedTabs"}'
```

Close all tabs in the AI Tool group:

```bash
curl -X POST http://127.0.0.1:8898 -H "Content-Type: application/json" -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" -d '{"action":"cleanupManagedTabs","closeTabs":true}'
```
