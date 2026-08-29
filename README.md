# Chrome Controller

A local Chrome control bridge for AI agents.

- **`Chrome Extension/`** — MV3 Chrome extension (`p agent extension`)
- **`src/native-host.ts`** — Native Messaging stdio host + `/tmp/chrome-controller.sock` Unix IPC
- **`src/server.ts`** — Standalone WebSocket/HTTP relay server (compiled to `dist/server.js`)
- **`src/mcp.ts`** — MCP stdio server (compiled to `dist/mcp.js`)
- **`src/index.ts`** — Pi / Antigravity extension entry point

## Quick Start (Native Messaging — Zero Ports)

1. **Install dependencies & build:**
   ```bash
   npm install && npm run build
   ```
2. **Install Native Messaging Host:**
   ```bash
   npm run install-host <EXTENSION_ID>
   ```
   *(For Chrome Web Store version, use `npm run install-host gocbenlgkgeaiifofilndbnaeigpplca`)*

3. **Configure MCP:**
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
   Chrome will automatically spawn the native host process over stdio/IPC on demand.

## Standalone Relay Server (HTTP/WebSocket Fallback)

For environments where Native Messaging manifests are not installed:

```bash
npm start
```
Starts the relay server on `http://127.0.0.1:8898` (WebSocket `ws://127.0.0.1:8899`). Dynamic OS ports are supported by omitting fixed port env vars.

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

## Chrome Web Store assets

Generate the required icon, screenshot, and small promotional tile plus the optional marquee tile:

```bash
npm run generate-store-assets
```

Upload-ready files are written to `store-assets/`. The product screenshot is captured through the running unpacked extension on a neutral local demo page so it represents actual functionality without exposing private browsing or customer data.

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
