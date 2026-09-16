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
- **Node.js** v18.0.0 or higher.
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

---

## Operational Modes

### Mode 1: Native Messaging (Primary — Zero Open Ports)
- **Security**: Chrome spawns `scripts/native-host-launcher.sh` directly via standard I/O (`stdio`).
- Communication with agent processes occurs over the user-isolated Unix socket `/tmp/chrome-controller.sock`.
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

The extension will automatically connect to the WebSocket relay server if the Native Messaging host is not registered.

---

## Visual Safety & Tab Isolation

1. **AI Tool Tab Group**: All tabs opened or attached by the agent are placed in a colored Chrome Tab Group labeled **`AI Tool`**.
2. **Page Title Prefix**: Controlled tab page titles are prefixed with `🤖 `.
3. **On-Page HUD**: An action bar at the top of the webpage displays current actions in real-time.
4. **Cleanup Tabs Command**:
   - Release HUD and group markers:
     ```bash
     curl -X POST http://127.0.0.1:8898 -H "Content-Type: application/json" -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" -d '{"action":"cleanupManagedTabs"}'
     ```
   - Close all AI Tool tabs:
     ```bash
     curl -X POST http://127.0.0.1:8898 -H "Content-Type: application/json" -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" -d '{"action":"cleanupManagedTabs","closeTabs":true}'
     ```

---

## Troubleshooting & FAQs

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
