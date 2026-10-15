# Chrome Controller — Comprehensive User & Developer Guide

`chrome-controller` is a local bridge and Chrome extension (`p agent extension`) that lets AI agents (Pi, Claude Desktop, Antigravity, Cursor, OpenCode, etc.) interact with browser tabs cleanly and securely without stealing your mouse cursor or keyboard focus.

---

## Table of Contents

1. [Architecture & How It Works](#architecture--how-it-works)
2. [Prerequisites](#prerequisites)
3. [Path A: Chrome Web Store Installation (Recommended for Users)](#path-a-chrome-web-store-installation-recommended-for-users)
4. [Path B: Self-Development & Local Build (For Developers)](#path-b-self-development--local-build-for-developers)
5. [AI Agent & MCP Configuration](#ai-agent--mcp-configuration)
   - [Claude Desktop](#claude-desktop)
   - [Antigravity / Gemini CLI](#antigravity--gemini-cli)
   - [Cursor & Windsurf](#cursor--windsurf)
   - [Pi Coding Agent](#pi-coding-agent)
6. [Operational Modes](#operational-modes)
   - [Mode 1: Native Messaging (Primary — Zero Open Ports)](#mode-1-native-messaging-primary--zero-open-ports)
   - [Mode 2: Standalone Relay Server (HTTP/WebSocket Fallback)](#mode-2-standalone-relay-server-httpwebsocket-fallback)
7. [Visual Safety & Tab Isolation](#visual-safety--tab-isolation)
8. [Troubleshooting & FAQs](#troubleshooting--faqs)

---

## Architecture & How It Works

Traditional browser automation tools (like Puppeteer or remote CDP ports) often require opening debug ports across your network or launching isolated, separate browser windows that don't share your login sessions.

Chrome Controller takes a different approach:
- **Zero Open Network Ports**: Uses Chrome's built-in **Native Messaging** API (`stdio`) and a local Unix domain socket (`~/.chrome-controller/run/chrome-controller.sock`) restricted to your user account (`0600`).
- **Tab Isolation**: Every tab controlled by the agent is automatically moved into a dedicated, visible tab group named **`AI Tool`**. Your personal tabs are never touched or monitored.
- **On-Page HUD**: The controlled page displays an unobtrusive status overlay and visual action badges showing exact click coordinates and current agent operations.
- **No Background Spying**: The extension does **not** request access to browser history or stored cookies.

```
┌────────────────────────────────────────────────────────┐
│                      AI Agent                          │
│     (Claude Desktop / Antigravity / Cursor / Pi)       │
└──────────────────────────┬─────────────────────────────┘
                           │ (MCP / Stdio or TS API)
                           ▼
┌────────────────────────────────────────────────────────┐
│            chrome-controller MCP Bridge                │
│             (~/.chrome-controller/run/chrome-controller.sock)             │
└──────────────────────────┬─────────────────────────────┘
                           │ (Unix IPC / Stdio Framing)
                           ▼
┌────────────────────────────────────────────────────────┐
│           Chrome Native Messaging Host                 │
│         (com.dst.chrome_controller.json)               │
└──────────────────────────┬─────────────────────────────┘
                           │ (Chrome Native Messaging API)
                           ▼
┌────────────────────────────────────────────────────────┐
│           "p agent extension" (MV3)                    │
│      - AI Tool Tab Group  - Live Action HUD            │
│      - DOM Selectors      - CDP Remote Debugger        │
└────────────────────────────────────────────────────────┘
```

---

## Prerequisites

- **Google Chrome** (or Chromium-based browser with Native Messaging support).
- **Node.js** v22.19.0 or higher for repository installation, builds and tests (the pinned development Pi SDK requires this version).
- **macOS** or **Linux** (Windows supported via WSL).

---

## Path A: Chrome Web Store Installation (Recommended for Users)

If you just want to use Chrome Controller with your AI agent without modifying the extension source code:

### Step 1: Install the Extension
Install **p agent extension** directly from the [Chrome Web Store](https://chromewebstore.google.com/detail/p-agent-extension/gocbenlgkgeaiifofilndbnaeigpplca).

- Extension ID: `gocbenlgkgeaiifofilndbnaeigpplca`

### Step 2: Clone and Build the Local Bridge
In your terminal, clone this repository and build the native host:

```bash
git clone https://github.com/dst0/chrome-controller.git
cd chrome-controller
npm install
npm run build
```

### Step 3: Register the Native Messaging Host
Run the registration script with the Web Store Extension ID:

```bash
npm run install-host gocbenlgkgeaiifofilndbnaeigpplca
```

This writes the Native Messaging manifest to:
- **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dst.chrome_controller.json`
- **Linux**: `~/.config/google-chrome/NativeMessagingHosts/com.dst.chrome_controller.json`

### Step 4: Verify the Setup
1. Click the **p agent extension** icon in your Chrome toolbar.
2. The popup will display:
   - **Extension ID**: `gocbenlgkgeaiifofilndbnaeigpplca`
   - **Local Host Setup Command**: `npm run install-host gocbenlgkgeaiifofilndbnaeigpplca`
   - **Bridge Status**: Shows whether the native host is connected.

---

## Path B: Self-Development & Local Build (For Developers)

If you are developing features, hacking on the extension, or modifying the controller:

### Step 1: Clone and Build
```bash
git clone https://github.com/dst0/chrome-controller.git
cd chrome-controller
npm install
npm run build
```

### Step 2: Load the Unpacked Extension in Chrome
1. Open Chrome and navigate to `chrome://extensions`.
2. Turn on the **Developer mode** toggle in the top-right corner.
3. Click the **Load unpacked** button.
4. Select the `Chrome Extension` folder inside your cloned repository:
   `/path/to/chrome-controller/Chrome Extension`
5. Chrome will assign a local 32-character Extension ID (e.g. `abcdefghijklmnop...`).

### Step 3: Register the Native Host for Your Local ID
Copy the Extension ID shown on your `chrome://extensions` card or click the extension's popup icon to see it, then run:

```bash
npm run install-host <YOUR_LOCAL_EXTENSION_ID>
```

For example:
```bash
npm run install-host abcdabcdabcdabcdabcdabcdabcdabcd
```

### Step 4: Developer Workflow & Scripts
- **Recompile TypeScript**: `npm run build` or `npm run typecheck`
- **Run Tests**: `npm test`
- **Run Linter**: `npm run lint`
- **Package for Web Store**: `npm run package` (produces `dist/chrome-extension-v<version>.zip`)
- **Regenerate Store Artwork & Screenshot**: `npm run generate-store-assets`
- **Reloading the Extension**: After editing files in `Chrome Extension/`, click the reload (🔄) icon on `chrome://extensions`.

---

## AI Agent & MCP Configuration

Chrome Controller provides an MCP (Model Context Protocol) server at `dist/mcp.js`.

### Claude Desktop

Edit your Claude Desktop configuration file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "chrome-controller": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/chrome-controller/dist/mcp.js"]
    }
  }
}
```

### Antigravity / Gemini CLI

In `~/.gemini/antigravity/mcp_config.json` (or workspace `.agents/mcp_config.json`):

```json
{
  "mcpServers": {
    "chrome-controller": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/chrome-controller/dist/mcp.js"]
    }
  }
}
```

### Cursor & Windsurf

In `.cursor/mcp.json` or global Cursor settings:

```json
{
  "mcpServers": {
    "chrome-controller": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/chrome-controller/dist/mcp.js"]
    }
  }
}
```

### Pi Coding Agent

If you use Pi, Chrome Controller is a native extension:
```bash
pi -e /path/to/chrome-controller/src/index.ts
```

The Pi tools talk to the native host over the IPC socket first. Their errors say which side failed,
and only an unreachable socket may fall back to the HTTP relay (when `CHROME_CONTROLLER_ALLOW_RELAY=1`,
`CHROME_CONTROLLER_URL`, or `HTTP_PORT` is set; `CHROME_CONTROLLER_URL` skips IPC entirely):

- `NATIVE_IPC_UNAVAILABLE`: the socket could not be opened (no host, or a stale socket). The request
  never reached the host. With relay permission the request goes to the relay instead.
- `NATIVE_IPC_TIMEOUT`: the host accepted the request but missed its own deadline for it (see the
  timeout budget below). A healthy host waiting on a slow Chrome answers `Native Messaging request
  timed out after <N>ms` instead, so suspect a wedged host and run `npm run watchdog`.
- `NATIVE_IPC_PROTOCOL_ERROR`: the host closed or broke the connection, or sent an unreadable answer.
- A host answer with `success: false` is returned to the agent unchanged. The host is healthy; the
  command itself failed.

Timeouts and protocol errors are never replayed over the relay, because the host may already have
clicked, filled, or opened a tab. An aborted tool call is never sent to the relay either.
`chrome_controller_health` follows the same rule: when the host answers but refuses the `queryTabs`
probe, it reports `{ "success": false, "mode": "NativeMessagingIPC", "error": "..." }` instead of
consulting the relay, plus the host's own view from `hostPing` when available: `extensionConnected`,
`sensitiveExtractionInProgress`, and `browserOutputQuarantined`.

---

## Operational Modes

### Mode 1: Native Messaging (Primary — Zero Open Ports)
- **Security**: Chrome spawns `scripts/native-host-launcher.sh` directly via standard I/O (`stdio`).
- If Chrome Controller commands hang rather than fail, the native host may be wedged: the process is
  alive and its socket still accepts connections, but it answers nothing, and SIGTERM will not stop it.
  Run `npm run watchdog` to identify the state and `npm run watchdog -- --recover` to clear it, then
  toggle the extension off and on at `chrome://extensions` to make Chrome spawn a fresh host.
- MCP tool errors say which side failed. Only `NATIVE_IPC_UNAVAILABLE` means the socket could not be
  reached (no host, or a stale socket), and only that error may fall back to the HTTP relay when
  `CHROME_CONTROLLER_ALLOW_RELAY=1`:
  - `NATIVE_IPC_UNAVAILABLE`: the connection could not be opened. The request never reached the host.
  - `NATIVE_IPC_TIMEOUT`: the host accepted the request but missed its own deadline for it (see the
    timeout budget below). A healthy host waiting on a slow Chrome answers `Native Messaging request
    timed out after <N>ms` instead, so suspect a wedged host and run `npm run watchdog`.
  - `NATIVE_IPC_PROTOCOL_ERROR`: the host closed or broke the connection, or sent an unreadable answer.
  - Any other message (for example `The extensions gallery cannot be scripted.`) is the host's own
    answer, passed through unchanged. The host is healthy; the command itself failed.

  Timeouts and protocol errors are never retried automatically, because the command may already have
  run in Chrome.
- Every request's timeouts come from one budget (`src/chrome-wait.ts`). The host waits 15 s for Chrome,
  plus the action's own working time (a recording's frames, a console-collection window, animated typing),
  up to 120 s. Agent clients wait 2 s longer than the host. So `Native Messaging request timed out after
  <N>ms` means the host is fine and Chrome did not answer, while `NATIVE_IPC_TIMEOUT` means the host itself
  missed its deadline: run `npm run watchdog`. A request that cannot finish within 120 s even on
  an instant Chrome (a longer console window, very long typing) is refused at once; split it instead.
  Set a request's wait explicitly with `requestTimeoutMs`. On `getConsoleLogs`, `timeoutMs` is the
  collection window, not a wait.
- Communication with agent processes occurs over the user-isolated Unix socket `~/.chrome-controller/run/chrome-controller.sock` (or `$XDG_RUNTIME_DIR/chrome-controller/run.sock` when that variable is set), in a directory created with mode `0700` and verified to be owned by the current user.
- No listening TCP ports are opened, preventing any local network sniffing or unauthorized local access.

### Mode 2: Standalone Relay Server (HTTP/WebSocket Fallback)
For environments where Native Messaging manifests cannot be installed (e.g. some CI pipelines, sandboxes):

```bash
npm start
```

This starts:
- HTTP API: `http://127.0.0.1:8898`
- WebSocket Server: `ws://127.0.0.1:8899`

Check health:
```bash
curl http://127.0.0.1:8898/health
```

The extension connects to the WebSocket relay only after the current browser session has received per-instance credentials through Native Messaging. If a cold session cannot complete that pairing, fallback stays disabled rather than using a shared public key.

---

## Visual Safety & Tab Isolation

1. **AI Tool Tab Group**: All tabs opened or attached by the agent are placed in a colored Chrome Tab Group labeled **`AI Tool`**.
2. **Page Title Prefix**: Controlled tab page titles are prefixed with `🤖 `.
3. **On-Page HUD**: An action bar at the top of the webpage displays current actions in real-time.
4. **Cleanup Tabs Command**: Use `chrome_cleanup_ai_tabs` to release markers, or pass `closeTabs: true` to close all managed tabs. The relay key remains in private discovery/session state and must not be copied into shell history.

---

## Troubleshooting & FAQs

### Runtime update checklist

1. Record the source revision and package version, then run `npm ci --ignore-scripts`,
   `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm audit`.
   The Pi CLI is a pinned development dependency and an optional runtime peer. MCP-only
   installations can omit development dependencies after building; they do not need Pi.
2. Run `npm run watchdog` and record the running host PID. A build changes files on disk,
   not code already loaded by that PID. Inspect the extension's version and source at
   `chrome://extensions`; repository, bridge and Web Store versions can differ.
3. Before disabling, reloading or updating the extension, finish concurrent controller
   requests and let secret guards expire. Chrome clears extension session storage on
   reload/disable/update; native-host exit also clears its in-memory redaction guards.
   Older `hostPing` responses expose pending requests, extraction and quarantine state,
   but do not prove that every redaction guard expired. Establish recent guarded-operation
   history before restarting; an idle health response alone is insufficient.
4. Preserve the native-host manifest before testing an unpacked extension. The installer
   replaces its allowlist with one supplied ID. Keep the Store installation available for
   rollback, register only the exact intended origins, and enable only one extension
   against a given IPC socket. Do not restart Chrome or clear profiles, cookies or tabs.
5. Prove the resulting version using a disposable localhost page: Unicode input through
   `chrome_type_text`, selection, click, DOM readback and screenshot through Pi. Basic DOM
   fill/click success does not prove that the input CDP batch path works. Never run global
   managed-tab cleanup in a shared browser; close only the test's recorded tab IDs.


### Q: Popup says "Disconnected / Local bridge not running"
1. Verify you ran `npm run build` after cloning the repository.
2. Verify you ran `npm run install-host <EXTENSION_ID>` with your exact Extension ID.
3. Make sure the launcher script is executable:
   ```bash
   chmod +x scripts/native-host-launcher.sh
   ```

### Q: What is the Web Store Extension ID?
The Chrome Web Store extension ID is:
`gocbenlgkgeaiifofilndbnaeigpplca`

### Q: Where is the Native Messaging manifest stored?
- **macOS**:
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dst.chrome_controller.json`
- **Linux**:
  `~/.config/google-chrome/NativeMessagingHosts/com.dst.chrome_controller.json`

### Q: Can Chrome Controller read my passwords or bank accounts?
No. The extension does not request permissions for stored cookies or browsing history, and by design it only attaches to tabs created or explicitly selected by the agent inside the `AI Tool` group.
