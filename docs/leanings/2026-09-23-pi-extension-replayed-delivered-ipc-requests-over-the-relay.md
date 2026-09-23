# 2026-09-23 — Pi extension replayed delivered IPC requests over the relay

- **Status:** Resolved
- **Task/context:** Pi extension client in `src/index.ts`, following the same failure-classification
  work on the MCP client (`src/mcp.ts`, branch `fix/distinguish-native-ipc-failures`, not merged at
  the time of this change).
- **Unexpected observation or failure:** Four defects in the Pi IPC client:
  1. A timeout or an unparseable answer was labelled `NATIVE_IPC_UNAVAILABLE` and, with relay
     permission, replayed over the HTTP relay, so a click, fill, or `createTab` the host had already
     run could run twice.
  2. `chrome_controller_health` fell through to the relay when the host answered `success: false`,
     without checking relay permission, producing `RELAY_CONFIG_UNAVAILABLE` for a healthy host.
  3. Each chunk was decoded with `chunk.toString('utf8')`, turning a multi-byte character split
     across reads into replacement characters, and without a `close` handler a host that exited
     mid-request made the client wait the full 10 s timeout.
  4. Found by the adversarial test review after the first fix: each chunk rescanned the whole
     buffer for `\n`, so large answers were quadratic (16 MB took ~9 s on macOS 8 KB reads, enough to
     be misreported as a timeout); `net.connect(socketPath)` treated a numeric path as a TCP port
     (`CHROME_CONTROLLER_SOCKET=8898` would dial the relay port, `99999` threw a `RangeError` that
     surfaced as `undefined`); the IPC path ignored the tool's abort signal, so an aborted click was
     still delivered; and health's `extensionConnected: false` was wrong when the host refused
     `queryTabs` because it was locked or quarantined.
  5. None of the IPC path ran under `npm test`: it was gated on `NODE_ENV !== 'test'`, and the test
     script sets `NODE_ENV=test`.
- **Evidence:** `src/index-ipc.test.ts` against a fake `net.Server` on a temp socket. With the gate
  bypassed (`NODE_ENV=dev`) on the old code, 9 of 18 tests failed, including 10 s waits for the
  timeout and host-exit cases and a mangled `🌍`. Under `NODE_ENV=test`, 15 of 18 failed because IPC
  was never attempted.
- **Approaches tried:**
  - **Attempt:** Keep the `NODE_ENV` gate and test only the relay path.
    - **Outcome:** Did not work
    - **Why:** It is the reason the bugs shipped: the production transport had no coverage.
  - **Attempt:** Remove the gate; point every test at a temp socket through
    `CHROME_CONTROLLER_SOCKET`; inject the IPC timeout through an optional second argument to the
    extension factory (Pi passes only the first).
    - **Outcome:** Worked
    - **Why:** Tests exercise the real socket code without touching a real host, and timeout cases
      take 400 ms instead of 10 s. `src/index.test.ts` also points the socket at a nonexistent path as
      a guard.
  - **Attempt:** Move the MCP client (`src/mcp.ts`) onto the new shared module in the same change.
    - **Outcome:** Deferred
    - **Why:** The MCP classification was uncommitted in another worktree; editing `src/mcp.ts` here
      would conflict with it. The new `src/ipc-client.ts` uses the same transport kinds and messages
      (the MCP wrapper will keep its own `rejected` handling for `success: false`).
  - **Attempt:** Report `extensionConnected: false` whenever the host refuses the health probe.
    - **Outcome:** Did not work
    - **Why:** The host also refuses while locked or quarantined with Chrome connected. Health now
      follows a refusal with `hostPing`, which the host answers locally with its real state.
- **Root cause:** The client treated every IPC failure as "host unreachable", although only a failed
  connect proves the request was never delivered. The test gate hid the path from CI.
- **Resolution:** New shared `src/ipc-client.ts` (`sendIpcRequest`, `IpcError` with kinds
  `unavailable | timeout | protocol`, `describeIpcFailure`). The client scans only each new chunk for
  the newline, connects with `{ path }`, honours the abort signal, and validates the timeout.
  `src/index.ts` falls back to the relay only on `unavailable`; health reports a refusal as
  `{ success: false, mode: 'NativeMessagingIPC', error, ...hostPing state }`.
- **Verification:** `npm test` (all suites, including 35 new IPC tests), `npm run typecheck`,
  `npm run lint`. A mutation pass reverting each fix (quadratic scan, bare-string connect, abort
  listener, pre-abort check, `client.end()`, `clearTimeout`) makes at least one test fail.
- **Prevention/follow-up:** Move `src/mcp.ts` onto `src/ipc-client.ts` after
  `fix/distinguish-native-ipc-failures` merges. Error contract documented in `docs/user-guide.md`
  (Pi Coding Agent) and `skills/chrome-controller/SKILL.md`.
- **Reusable learning:** When accumulating a line-framed stream, search only the new chunk. A retry or fallback to another transport is safe only when the failure
  proves the request was never delivered. Classify transport errors by whether the connect succeeded,
  and never gate the production transport off in tests: inject its endpoint and timeouts instead.
- **References:** `src/ipc-client.ts`, `src/index-ipc.test.ts`,
  `docs/leanings/2026-09-23-wedged-native-host-swallows-sigterm-and-needs-external-liveness-probe.md`.
