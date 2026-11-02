# Chrome Web Store Listing Copy

Use this text in the **Chrome Web Store Developer Console** for item:
[p agent extension (Edit Item)](https://chrome.google.com/webstore/devconsole/9a5c4d7a-94b2-4dd1-bc8b-676349c60d48/gocbenlgkgeaiifofilndbnaeigpplca/edit)

Extension ID: `gocbenlgkgeaiifofilndbnaeigpplca`

This file is the source of truth for every text field in the listing and the Privacy practices
tab. Edit it here first, then copy it into the console. Text typed only into the console is lost:
the 2026-09-20 description edit existed nowhere else until it was recovered from a session
transcript (kept below under "Published before 1.3.2").

The GitHub links work only while the repository is public. The repository carries
an MIT license.

---

## 1. Summary / Short Description (under 132 characters)

```text
Local browser control for AI agents (Pi, p and MCP clients) via Native Messaging, in a visible AI Tool tab group.
```

---

## 2. Detailed Description (Store Overview)

```text
p agent extension is a companion extension that lets AI agents control browser tabs on your own computer: the Pi coding agent, its fork p, and MCP clients such as Claude Desktop, Cursor and Antigravity.

Everything the agent does happens in a dedicated, clearly marked "AI Tool" tab group, with an on-page HUD that shows each action. The extension does not touch your other tabs.

Source code, setup guide and issues: https://github.com/destinationworks/chrome-controller
Pi coding agent: https://pi.dev
p agent harness: https://p-agent.pages.dev

------------------------------------------------------------
HOW IT WORKS
------------------------------------------------------------
The extension talks to a small local bridge that you install on your computer. Chrome starts the bridge on demand through Native Messaging, and agents reach it through a local Unix domain socket. No network listener is needed; an optional fallback relay binds to 127.0.0.1 only. The bridge must be installed for agent-control features to work.

1. Install this extension from the Chrome Web Store.
2. Install the local bridge and register it with Chrome:
   git clone https://github.com/destinationworks/chrome-controller.git
   cd chrome-controller
   npm install && npm run build
   npm run install-host gocbenlgkgeaiifofilndbnaeigpplca
3. Connect your agent:
   • Pi: pi -e /path/to/chrome-controller/src/index.ts
   • p: p -e /path/to/chrome-controller/src/index.ts
   • MCP clients: add this server to the client's MCP config:
     {
       "mcpServers": {
         "chrome-controller": {
           "command": "node",
           "args": ["/path/to/chrome-controller/dist/mcp.js"]
         }
       }
     }

When you update the extension, update the local bridge too (git pull, npm install, npm run build). Guarded secret operations need matching versions and refuse to run otherwise.

------------------------------------------------------------
KEY FEATURES
------------------------------------------------------------
• Dedicated tab group: every agent-controlled tab joins a visible "AI Tool" tab group.
• On-page HUD and visualizer: shows the current action, cursor and click points, and element badges, so you can see what the agent is doing.
• Browser automation: open, select, group and close tabs, inspect page structure and interactive elements, click, type, select options, fill forms, take screenshots, record short videos and run page scripts.
• Guarded secret handling: companion tools can read or fill a secret field while all later page output masks that value. The target tab is checked before any value is captured, and an uncertain failure closes the tab or keeps browser output locked.
• Local only: Native Messaging and a Unix domain socket by default; the fallback relay never listens beyond 127.0.0.1.

------------------------------------------------------------
TRANSPARENCY & PRIVACY
------------------------------------------------------------
• What it can do: when instructed by the connected agent, the extension can read tab titles and URLs, inspect page content and structure, capture screenshots, and interact with page controls. It shows that activity on the page so you can see which tab and elements the agent is working with.
• No cookie or history permissions: the extension does not request them.
• Minimal storage: Chrome session storage holds only protected-tab guard state across service-worker restarts. No page content, credentials, cookies or history are stored.
• No data collection: no analytics, telemetry, advertising, affiliate tracking or cookie management. The extension sends nothing to external servers; what your agent does with page data is governed by that agent's own configuration and privacy practices.
• Only use the extension on pages you are authorized to automate.
• Source code: https://github.com/destinationworks/chrome-controller
• Privacy policy: https://github.com/destinationworks/chrome-controller/blob/main/PRIVACY.md

------------------------------------------------------------
WHAT'S NEW IN 1.3.2
------------------------------------------------------------
• Guarded secret transfers verify that the target tab exists before capturing or filling a value; unsupported or missing targets fail closed.
• Content commands that Chrome does not acknowledge are rejected instead of reported as done.
• No new permissions.
```

---

## 3. Homepage URL Field

```text
https://github.com/destinationworks/chrome-controller
```

The console's separate **Official URL** field accepts only a site verified in Google Search
Console, so a GitHub address cannot go there. Leave it as "None" unless a verified site exists.

## 4. Support URL Field

```text
https://github.com/destinationworks/chrome-controller/issues
```

## 5. Privacy Policy URL Field (Privacy practices tab)

```text
https://github.com/destinationworks/chrome-controller/blob/main/PRIVACY.md
```

## 6. Category and Language

```text
Category: Developer Tools
Language: English
Mature content: No
```

---

## 7. Privacy Practices Tab

### Single purpose description

```text
Enables local AI coding agents to control Chrome browser tabs and interact with web pages via local Native Messaging IPC.
```

### Permission justifications

```text
tabs: Required to query open tabs and create new tabs managed by the local AI agent.
debugger: Required to send DevTools Protocol commands for page interactions, screenshots, and element inspection.
tabGroups: Required to group AI-controlled tabs into a visible tab group with overlay markers.
alarms: Required for background keepalive and reconnect timers, and to expire protected-tab guards on schedule.
storage: Required to persist local security-guard state across service-worker suspension, restart, and timer callbacks. It stores no page content, credentials, cookies, or browsing history.
nativeMessaging: Required to establish standard I/O IPC communication with the local native host process on the user's computer.
Host permission: Required to interact with target web pages opened by the local AI agent.
```

### Other answers

```text
Remote code: No, I am not using remote code.
Data usage: no data type is collected (leave every category unchecked).
Certifications: tick all three (no sale of data, no unrelated use, no creditworthiness use).
```

---

## Published before 1.3.2

Recovered on 2026-10-31 from the Codex session that last edited the console on 2026-09-20
(the original copy was written on 2026-08-23). Kept for comparison and rollback; do not paste it.

- Summary (from the manifest `description`): `Local browser control bridge for AI agents via Native Messaging`
- Homepage, Support and Privacy policy URLs: empty. Official URL: None.
- The `alarms` justification read "Required to maintain background keepalive timers."

Description:

```text
p agent extension is a companion browser extension for compatible AI agents running through a local MCP or Pi bridge.

It provides a visible, locally controlled interface that lets a configured AI agent work with browser tabs and page controls.

Features:

• Open, select, group, manage, and close browser tabs
• Inspect visible page structure and interactive elements
• Click buttons, enter text, and select page options
• Capture screenshots and page information
• Run supported browser automation commands
• Show active automation through an on-page HUD, element badges, cursor indicators, and a visible tab group

How it works:

A separately installed local bridge connects the extension to compatible AI-agent software through Native Messaging or a localhost connection. The local bridge must be running for agent-control features to work.

Transparency and privacy:

When instructed by the connected agent, the extension can read tab titles and URLs, inspect page content and structure, capture screenshots, and interact with page controls.

The extension displays controlled activity on the page so users can see which tab and elements the agent is working with.

The extension uses Chrome local storage only for local security-guard state across service-worker restarts; it does not store page content, credentials, cookies, or browsing history. It contains no advertising, affiliate tracking, or cookie-management functionality.

Information handled by the connected AI agent is subject to that agent’s configuration and privacy practices. Only use the extension on pages you are authorized to automate.
```
