# Chrome Web Store Listing Copy

Use this text in the **Chrome Web Store Developer Console** for item:
[p agent extension (Edit Item)](https://chrome.google.com/webstore/devconsole/9a5c4d7a-94b2-4dd1-bc8b-676349c60d48/gocbenlgkgeaiifofilndbnaeigpplca/edit)

Extension ID: `gocbenlgkgeaiifofilndbnaeigpplca`

---

## 1. Summary / Short Description (under 132 characters)

```text
Local browser control bridge for AI agents via Native Messaging and MCP.
```

---

## 2. Detailed Description (Store Overview)

```text
p agent extension is an open-source companion browser extension that allows AI agents (such as Pi, Claude Desktop, Antigravity, Cursor, and OpenCode) to interact with browser tabs cleanly and securely.

All control actions are confined strictly to a dedicated, clearly marked "AI Tool" tab group so the agent never touches or interferes with your personal browsing tabs, saved cookies, or history.

GitHub Repository & Full Setup Guide:
https://github.com/dst0/chrome-controller

------------------------------------------------------------
HOW IT WORKS
------------------------------------------------------------
The extension connects to an open-source local bridge installed on your computer using Chrome's Native Messaging IPC. Unlike traditional remote-control tools, it does not require opening open listening network ports.

1. Install this extension from the Chrome Web Store.
2. Clone the local bridge and register the native host launcher:
   git clone https://github.com/dst0/chrome-controller.git
   cd chrome-controller
   npm install && npm run build
   npm run install-host gocbenlgkgeaiifofilndbnaeigpplca
3. Add chrome-controller to your agent's MCP config:
   {
     "mcpServers": {
       "chrome-controller": {
         "command": "node",
         "args": ["/path/to/chrome-controller/dist/mcp.js"]
       }
     }
   }

When your AI agent issues a browser command, Chrome automatically starts the local native host on demand.

------------------------------------------------------------
KEY FEATURES
------------------------------------------------------------
• Dedicated Tab Group: Automatically groups all AI-controlled tabs into a visible "AI Tool" tab group.
• In-Page HUD & Visualizer: Clearly displays active agent actions, click coordinates, and element badges so you always see what the AI is doing.
• Zero Open Network Ports: Uses Chrome Native Messaging (stdio) and local Unix domain socket IPC instead of listening on external network interfaces.
• Broad Tool Support: Compatible with Model Context Protocol (MCP) clients including Claude Desktop, Cursor, Antigravity, and the Pi coding agent.
• DOM & CDP Automation: Inspect page structure, click selectors, fill inputs, navigate, take screenshots, and evaluate scripts.

------------------------------------------------------------
TRANSPARENCY & PRIVACY
------------------------------------------------------------
• No Cookie Access: Does not request or possess cookie access permissions.
• No Browsing History Access: Cannot read or query your browser history.
• No Remote Data Collection: Transmits zero analytics, telemetry, or user data to external servers. All communication is 100% local between your agent and Chrome.
• Open Source: Fully auditable source code available on GitHub: https://github.com/dst0/chrome-controller
```

---

## 3. Official URL / Homepage URL Field

```text
https://github.com/dst0/chrome-controller
```

## 4. Support URL Field

```text
https://github.com/dst0/chrome-controller/issues
```
