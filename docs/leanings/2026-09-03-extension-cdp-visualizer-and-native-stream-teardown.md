# 2026-09-03 — Extension CDP visualizer runtime fix, synthetic DOM input setter, and stream teardown

- **Status:** Resolved
- **Task/context:** Feature expansion, DOM automation improvements, full Pi-to-MCP parity, and test suite hardening for Chrome Controller extension v1.1.2.
- **Unexpected observation or failure:**
  1. In `Chrome Extension/background.js`, `sendCommand` invoked `visualizeCdpCommand(...)` which was undefined, crashing CDP commands at runtime with `ReferenceError: visualizeCdpCommand is not defined`.
  2. In `Chrome Extension/content.js`, filling inputs on modern single-page applications (React, Vue, Angular) updated `el.value` but the framework state remained empty on form submission or blur.
  3. Node.js test suites hung indefinitely after running all test cases.
- **Evidence:**
  - Automated inspection of `Chrome Extension/background.js` showed `sendCommand` calling `visualizeCdpCommand` without any function definition.
  - Test runner processes for `src/native-host.test.ts` and `src/server.test.ts` stayed alive after assertions passed because `process.stdin` was flowing without `unref()`, `isMain` string check matched test file names ending with the module name, and `req.destroy()` during body-size limits aborted HTTP responses with `ECONNRESET`.
- **Approaches tried:**
  - **Attempt:** Simply stub `visualizeCdpCommand` as a no-op.
    - **Outcome:** Rejected approach.
    - **Why:** The visualizer hud and overlay badges in `content.js` provide real-time user visibility of agent mouse clicks, drags, and keystrokes.
  - **Attempt:** Implement full `visualizeCdpCommand` and `mouseEventTypeToVisualType` in `background.js` to dispatch visual events to `content.js`.
    - **Outcome:** Worked.
    - **Why:** Properly renders click ripple animations and keystroke indicators on the active web page during automated agent execution.
  - **Attempt:** Use standard `input.value = text; input.dispatchEvent(new Event('input'))`.
    - **Outcome:** Partial.
    - **Why:** React overrides standard value property setters on HTMLInputElement and HTMLTextAreaElement prototypes; directly mutating `.value` bypasses React's `_valueTracker`.
  - **Attempt:** Call `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set?.call(el, text)`.
    - **Outcome:** Worked.
    - **Why:** Invokes the prototype descriptor's native setter directly, allowing React/Vue synthetic event listeners to recognize value changes.
  - **Attempt:** Unref stdin, call `closeAllConnections()` on servers, and use exact regex for entrypoints.
    - **Outcome:** Worked.
    - **Why:** Tests exit cleanly in under 2 seconds across all 99 assertions.
- **Root cause:**
  1. Undefined visualizer helper was left after refactoring `background.js`.
  2. SPA frameworks shadow DOM property setters with custom state getters/setters.
  3. Node.js event loop remains open when libuv handles (stdin streams, unclosed client sockets, or loose `isMain` triggers) remain active.
- **Resolution:**
  - Implemented `visualizeCdpCommand` and `mouseEventTypeToVisualType` in `Chrome Extension/background.js`.
  - Added prototype property descriptor setters to `fillSelector` in `Chrome Extension/content.js`.
  - Added 6 missing MCP tools to `src/mcp.ts` (`chrome_type_text`, `chrome_mouse`, `chrome_extract_content`, `chrome_extract_regions`, `chrome_console_logs`, `chrome_cleanup_ai_tabs`).
  - Added `process.stdin.unref()` and `pause()` to `src/native-host.ts`, updated `isMain` detection to `/(?:^|[\\/])<name>\.(?:js|ts)$/`, and replaced abrupt socket destruction in `src/server.ts` with stream pause.
  - Bumped version to 1.1.2 across `package.json`, `manifest.json`, and store provenance metadata.
- **Verification:** All 99 automated tests passed cleanly in 1.9 seconds (`npm test`), build and packaging succeeded (`npm run package`), and native host installed cleanly.
- **Prevention/follow-up:** Always verify prototype descriptor setters when interacting with SPA inputs; avoid loose `.endsWith()` for CLI entrypoint guards.
- **Reusable learning:** When automating web forms via browser extensions, always invoke `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set?.call(el, value)` before dispatching `'input'` and `'change'` events to guarantee compatibility with React and modern UI frameworks.
- **References:** `Chrome Extension/background.js`, `Chrome Extension/content.js`, `src/native-host.ts`, `src/server.ts`, `src/mcp.ts`
