# Chrome Controller

Local Chrome control bridge with:

- a Chrome MV3 extension in `Chrome Extension`
- a Node HTTP/WebSocket server in `server`
- a Pi extension package in `PiDev Extension`

## Run

```bash
cd server
npm start
```

Then load `Chrome Extension` as an unpacked Chrome extension.

The HTTP API listens on `http://127.0.0.1:8898` by default. Override with:

```bash
HTTP_PORT=8898 WS_PORT=8899 API_KEY=your-key npm start
```

## Health

```bash
curl http://127.0.0.1:8898/health
```

## Single Action

```bash
curl -X POST http://127.0.0.1:8898 \
  -H "Content-Type: application/json" \
  -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
  -d '{"action":"queryTabs"}'
```

## Batch Actions

Parallel mode is the default:

```bash
curl -X POST http://127.0.0.1:8898 \
  -H "Content-Type: application/json" \
  -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
  -d '{"mode":"parallel","actions":[{"action":"queryTabs"},{"action":"queryTabs"}]}'
```

Use sequential mode for ordered browser interactions:

```bash
curl -X POST http://127.0.0.1:8898 \
  -H "Content-Type: application/json" \
  -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
  -d '{"mode":"sequential","actions":[{"action":"ensureDebugger","tabId":123},{"action":"sendCommand","tabId":123,"method":"Input.dispatchMouseEvent","commandParams":{"type":"mouseMoved","x":200,"y":160,"button":"none"}}]}'
```

## Pi

Run Pi with the local extension package:

```bash
pi -e "./PiDev Extension"
```

The package registers Chrome tools and a `chrome-controller` skill. Use `chrome_controller_health`, then `chrome_query_tabs` or `chrome_create_tab`, then `chrome_select_tab`, `chrome_mouse`, `chrome_type_text`, or `chrome_batch`.

## Antigravity

To use this plugin with Antigravity:

1. Copy or symlink the `PiDev Extension` folder to your Antigravity plugins directory:
   ```bash
   ln -s "$PWD/PiDev Extension" ~/.gemini/config/plugins/chrome-controller
   ```
2. Antigravity will automatically detect `plugin.json` and load the `chrome-controller` skill and its tools.


## Managed Tab Visibility

Every controlled tab is moved into a visible Chrome tab group named `AI Tool`.
While a tab is actively controlled, the page title is prefixed with `🤖 ` and the in-page HUD shows the current action, coordinates, and recent activity.

Release the active marker but keep managed tabs open:

```bash
curl -X POST http://127.0.0.1:8898 \
  -H "Content-Type: application/json" \
  -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
  -d '{"action":"cleanupManagedTabs"}'
```

Close all tabs in the `AI Tool` group:

```bash
curl -X POST http://127.0.0.1:8898 \
  -H "Content-Type: application/json" \
  -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
  -d '{"action":"cleanupManagedTabs","closeTabs":true}'
```
