# 2026-08-30 — Native Messaging host requires explicit origins, PATH resolution, and clean stdout framing


- **Status:** Resolved
- **Task/context:** Connect Chrome Web Store extension (`gocbenlgkgeaiifofilndbnaeigpplca`) to the local Chrome Controller MCP server via Native Messaging.
- **Unexpected observation or failure:** Extension reported `Error when communicating with the native messaging host.` when calling `chrome.runtime.connectNative("com.dst.chrome_controller")`.
- **Evidence:**
  1. The host manifest initially declared `"chrome-extension://*/"`. Chrome rejects wildcards for Native Messaging `allowed_origins`.
  2. The host launcher script executed `node` without ensuring macOS GUI PATH resolution (missing `/opt/homebrew/bin`).
  3. `src/native-host.ts` invoked `createChromeControllerServer()`, which printed plain text banners to `stdout` (`console.log`), corrupting Chrome's 32-bit length-prefixed binary framing and causing Chrome to immediately terminate the native host child process.
- **Approaches tried:**
  - **Attempt:** Keep wildcard `*` in manifest `allowed_origins`.
    - **Outcome:** Rejected approach
    - **Why:** Chrome's Native Messaging security specification strictly enforces explicit extension IDs.
  - **Attempt:** Keep inline HTTP/WS server startup inside `native-host.ts`.
    - **Outcome:** Did not work
    - **Why:** Startup logging printed to `stdout`, which violates Chrome's binary length-prefix framing protocol.
  - **Attempt:** Register exact Extension ID `gocbenlgkgeaiifofilndbnaeigpplca`, prepend Homebrew Node to launcher `PATH`, and remove all non-framed `stdout` writers from `native-host.ts`.
    - **Outcome:** Worked
    - **Why:** Stdio stream remains 100% binary framed JSON, and Chrome successfully validates and communicates with the host process.
- **Root cause:** Native Messaging requires strict origin registration and zero non-protocol stdout writes.
- **Resolution:** Updated `com.dst.chrome_controller.json` with the exact Web Store ID, added PATH exports to `scripts/native-host-launcher.sh`, and removed stdout-polluting sub-server startup from `src/native-host.ts`.
- **Verification:** `chrome_controller_health` and `chrome_query_tabs` MCP tools successfully communicated with Chrome and enumerated all open browser tabs.
- **Prevention/follow-up:** In native messaging host scripts, all diagnostic logging must strictly target `stderr` (`console.error`).
- **Reusable learning:** In Native Messaging hosts, `stdout` is exclusively reserved for length-prefixed JSON framing; any standard `console.log` output will corrupt the protocol stream and cause Chrome to drop the connection.
- **References:** `src/native-host.ts`, `scripts/native-host-launcher.sh`, `com.dst.chrome_controller.json`
