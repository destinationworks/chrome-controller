# Chrome Controller (`p agent extension`)

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-v1.1.2-blue.svg?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/p-agent-extension/gocbenlgkgeaiifofilndbnaeigpplca)
[![GitHub](https://img.shields.io/badge/GitHub-Repository-black.svg?logo=github)](https://github.com/dst0/chrome-controller)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-Passing-brightgreen.svg)](test)

A secure, local Chrome browser control bridge for AI agents (Claude Desktop, Antigravity, Cursor, Windsurf, OpenCode, and Pi).

Unlike remote CDP bridges or OS-level mouse-moving bots, Chrome Controller:
- **Never steals your cursor or keyboard focus**: Automation happens entirely inside the browser through DOM actions and CDP.
- **Confined to dedicated tabs**: Controlled tabs are automatically organized into an **`AI Tool`** tab group. Your personal tabs, history, and cookies are never accessed.
- **Zero open network ports**: Operates over Chrome's **Native Messaging** IPC (`stdio`) and a local Unix socket (`~/.chrome-controller/run/chrome-controller.sock`), preventing local network scanning or unauthorized access.
- **Visual On-Page HUD**: Displays real-time status banners and click indicators on the active tab so you always know what the agent is doing.

---

## Quick Navigation

- [Track 1: Getting Started with Chrome Web Store Extension (Recommended)](#-track-1-getting-started-with-chrome-web-store-extension-recommended)
- [Track 2: Self-Development & Hacking from Source](#-track-2-self-development--hacking-from-source)
- [Agent & MCP Configuration](#-agent--mcp-configuration)
- [Standalone Relay Server (Fallback Mode)](#-standalone-relay-server-fallback-mode)
- [Safety & Privacy Architecture](#-safety--privacy-architecture)
- [Documentation & Resources](#-documentation--resources)

---

## 🚀 Track 1: Getting Started with Chrome Web Store Extension (Recommended)

Use this path if you want to control Chrome with your AI agent using the officially published, pre-packaged extension.

### Step 1: Install Extension from Chrome Web Store
Install **[p agent extension](https://chromewebstore.google.com/detail/p-agent-extension/gocbenlgkgeaiifofilndbnaeigpplca)** from the Chrome Web Store.
- Official Extension ID: `gocbenlgkgeaiifofilndbnaeigpplca`

### Step 2: Clone and Install Local Host Bridge
In your terminal, clone this repository and register the native host launcher for the Web Store extension ID:

```bash
# 1. Clone this repository
git clone https://github.com/dst0/chrome-controller.git
cd chrome-controller

# 2. Install dependencies & compile TypeScript
npm install && npm run build

# 3. Register Chrome Native Messaging Host
npm run install-host gocbenlgkgeaiifofilndbnaeigpplca
```

### Step 3: Configure Your AI Agent (MCP)
Add `chrome-controller` to your agent's MCP settings (see [Agent & MCP Configuration](#-agent--mcp-configuration) below).

When your agent issues its first browser command, Chrome will automatically launch the native host in the background over stdio.

---

## 🛠️ Track 2: Self-Development & Hacking from Source

Use this path if you are developing new features, modifying the Chrome extension code, or running an unpacked version for testing.

### Step 1: Clone and Build
```bash
git clone https://github.com/dst0/chrome-controller.git
cd chrome-controller
npm install
npm run build
```

### Step 2: Load Unpacked Extension in Chrome
1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `Chrome Extension/` directory in this repo:
   ```
   /path/to/chrome-controller/Chrome Extension
   ```
4. Find the generated 32-character **Extension ID** displayed on the extension's card (or click the extension's toolbar icon to open the popup and copy it).

### Step 3: Register Native Host for Your Local ID
Run `npm run install-host` passing your unique local Extension ID:

```bash
npm run install-host <YOUR_LOCAL_EXTENSION_ID>
```

### Step 4: Developer Commands
- **Run test suite**: `npm test`
- **Typecheck code**: `npm run typecheck`
- **Lint source**: `npm run lint`
- **Package for Web Store**: `npm run package` (produces `dist/chrome-extension-v<version>.zip`)
- **Regenerate store promo artwork and screenshots**: `npm run generate-store-assets`
- **Reload extension**: Click the reload (🔄) button in `chrome://extensions` whenever you change files in `Chrome Extension/`.

---

## 🤖 Agent & MCP Configuration

Chrome Controller provides a standard [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server at `dist/mcp.js`.

### Configuration for Claude Desktop, Antigravity, Cursor, and Windsurf

Add the following to your MCP client's configuration file (e.g. `claude_desktop_config.json` or `.gemini/antigravity/mcp_config.json`):

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

*Replace `/ABSOLUTE/PATH/TO/chrome-controller` with the actual path to your cloned repository.*

### Using with Pi Coding Agent
Chrome Controller can be directly loaded into Pi:
```bash
pi -e /ABSOLUTE/PATH/TO/chrome-controller/src/index.ts
```

---

## 🌐 Standalone Relay Server (Fallback Mode)

For environments where Chrome Native Messaging cannot be installed (e.g. headless containers, sandboxed CI runners):

```bash
npm start
```
- Starts HTTP API on `http://127.0.0.1:8898`
- Starts WebSocket bridge on `ws://127.0.0.1:8899`

Check bridge health:
```bash
curl http://127.0.0.1:8898/health
```

The extension will automatically connect to the WebSocket relay server if the Native Messaging host is not registered.

---

## 🔒 Safety & Privacy Architecture

- **Dedicated Tab Group (`AI Tool`)**: All controlled tabs are automatically grouped into a prominent cyan tab group labeled `AI Tool`.
- **Title Prefix**: Controlled tab titles are prefixed with `🤖 ` while under automation.
- **Zero Open Ports**: In Native Messaging mode, communication uses Chrome stdio framing and an isolated Unix socket (`/tmp/chrome-controller.sock` with `0600` permissions).
- **Strict Least-Privilege Permissions**: The extension does not request permissions for `cookies`, `history`, or `storage`. It cannot read personal cookies or inspect untargeted tabs.
- **Cleanup Tabs Command**:
  ```bash
  # Close all AI Tool tabs and reset markers
  curl -X POST http://127.0.0.1:8898 \
    -H "Content-Type: application/json" \
    -H "x-api-key: B3C65095-74E1-4F48-9EBB-64F5DD6AB078" \
    -d '{"action":"cleanupManagedTabs","closeTabs":true}'
  ```

---

## 📚 Documentation & Resources

- [User & Developer Guide](docs/user-guide.md): In-depth walkthrough, configuration examples, and troubleshooting.
- [Chrome Web Store Listing Text](docs/chrome-web-store-listing.md): Store listing description and metadata for Developer Console.
- [Chrome Web Store Item](https://chromewebstore.google.com/detail/p-agent-extension/gocbenlgkgeaiifofilndbnaeigpplca): Official extension store page.
- [Developer Console Item Edit](https://chrome.google.com/webstore/devconsole/9a5c4d7a-94b2-4dd1-bc8b-676349c60d48/gocbenlgkgeaiifofilndbnaeigpplca/edit): Developer management console for this extension.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
