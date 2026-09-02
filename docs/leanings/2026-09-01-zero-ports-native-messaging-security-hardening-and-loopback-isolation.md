# 2026-09-01 — Zero-ports Native Messaging security hardening and loopback isolation

- **Status:** Resolved
- **Task/context:** Architectural hardening and adversarial review of Zero-Ports Native Messaging and fallback HTTP/WS relay server.
- **Unexpected observation or failure:**
  1. Default Unix domain socket path in `/tmp` had shared-directory security risks on multi-user systems.
  2. Fallback to network relay was attempting silent HTTP connections when Native IPC failed, violating zero-ports fail-closed expectations.
  3. `chrome_batch` accepted arbitrary action names and nested batches without validation.
  4. Content script messages (`sendTabMessage`) without frame filtering dispatched into nested iframe contexts.
  5. `nativePort.postMessage` in `background.js` was passing a stringified payload rather than a plain object, causing double serialization.
- **Evidence:**
  - Automated adversarial test review identified missing fail-closed gates, unverified socket permission boundaries, and double-encoding over `chrome.runtime.Port`.
  - Stale socket cleanup lacked UID matching, allowing potential cross-user unlinking collisions.
- **Approaches tried:**
  - **Attempt:** Keep shared `/tmp` socket with world access.
    - **Outcome:** Rejected approach.
    - **Why:** On shared Unix environments, any local process could inspect or connect to the socket.
  - **Attempt:** Move socket to per-user private directory `~/.chrome-controller/run/chrome-controller.sock` with `0700` directory mode and `0600` socket permissions, safe `lstat` cleanup with UID validation, loopback-only binding (`127.0.0.1`), explicit batch allowlists, default `{ frameId: 0 }` top-level targeting, and fail-closed error `NATIVE_IPC_UNAVAILABLE` unless `CHROME_CONTROLLER_ALLOW_RELAY=1` or `HTTP_PORT` is set.
    - **Outcome:** Worked.
    - **Why:** Completely isolates IPC communication to the owning user, prevents arbitrary/nested batch executions, and eliminates silent fallback.
- **Root cause:** Missing defense-in-depth permission boundaries, implicit fallback behavior, and lack of message frame targeting in extension message dispatching.
- **Resolution:**
  - Hardened `src/native-host.ts` with `0700` directory creation, `0600` socket permissions, 10MB line buffer cap, and UID-checked stale socket cleanup.
  - Hardened `src/server.ts` with explicit `127.0.0.1` binding, remote client IP loopback verification, and `ALLOWED_BATCH_ACTIONS` allowlist.
  - Hardened `src/mcp.ts` and `src/index.ts` with dynamic socket path resolution, fail-closed `NATIVE_IPC_UNAVAILABLE` errors, and explicit opt-in relay flags.
  - Hardened `Chrome Extension/background.js` with `{ frameId: 0 }` default targeting, batch allowlist validation, and fixed object dispatch to `nativePort`.
  - Added unit test suites in `src/native-host.test.ts`, `src/server.test.ts`, and `src/mcp.test.ts` covering 72 tests.
- **Verification:** All 72 unit tests across 6 test suites passed cleanly (`npm test`), typecheck passed (`npm run typecheck`), build succeeded (`npm run build`), extension package built (`npm run package`), and native host installed (`npm run install-host gocbenlgkgeaiifofilndbnaeigpplca`).
- **Prevention/follow-up:** Any new extension actions added to background.js must be registered in `ALLOWED_BATCH_ACTIONS`.
- **Reusable learning:** Native messaging IPC sockets must always reside in a `0700` user-owned directory with `0600` file permissions; socket cleanup must verify file ownership via `fs.lstatSync` UID matching before unlinking; and fallback relays must fail closed with actionable error messages rather than silently opening network ports.
- **References:** `src/native-host.ts`, `src/server.ts`, `src/mcp.ts`, `src/index.ts`, `Chrome Extension/background.js`, `src/native-host.test.ts`
