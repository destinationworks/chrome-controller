# 2026-09-23 — Duplicated IPC clients kept bugs fixed in only one copy

- **Status:** Resolved
- **Task/context:** Moving the MCP server (`src/mcp.ts`) onto the shared IPC client `src/ipc-client.ts`,
  which the Pi extension adopted in
  `2026-09-23-pi-extension-replayed-delivered-ipc-requests-over-the-relay.md`.
- **Unexpected observation or failure:** The MCP server kept its own copy of the socket client after
  the Pi fixes landed, so it still had bugs the shared client had already fixed:
  1. The newline search rescanned the whole buffer on every read, so a 16 MB answer (screenshots,
     video frames) took longer than a 3 s timeout on macOS and was reported as `NATIVE_IPC_TIMEOUT`.
  2. `net.connect(socketPath)` with a bare string treats a numeric path as a TCP port:
     `CHROME_CONTROLLER_SOCKET=8898` dialled the relay port on 127.0.0.1.
  3. The payload was serialized inside the connect callback, so an unserializable parameter threw
     outside the promise instead of failing the one call.
  4. An invalid timeout (`0`, `NaN`, `2 ** 31`) was passed to `setTimeout`, which clamps it to ~1 ms,
     and came back as a misleading host timeout.
- **Evidence:** New regression tests in `src/mcp.test.ts` run against the pre-change `src/mcp.ts`:
  the multi-megabyte test took 3027 ms against a 3000 ms timeout, the numeric-path test's TCP
  listener received the connection, and the unserializable-payload and invalid-timeout tests
  failed. All pass after the change. An adversarial review then ran targeted mutations of
  `src/mcp.ts`. Four survived: native-only actions sent to the relay when `HTTP_PORT` is set, a
  native-only timeout relabelled `NATIVE_IPC_UNAVAILABLE`, the MCP relay hint, and the
  `HostRejectedError` class. Each now has a test. The review also showed the 16 MB test only caught
  the quadratic scan on macOS (8 KB reads). Linux delivers ~64 KB reads, where the quadratic version
  finished in ~0.6 s, so the fake host now writes paced 8 KB slices.
- **Approaches tried:**
  - **Attempt:** Add a `rejected` kind to the shared `IpcError` so `mcp.ts` could keep its old
    control flow.
    - **Outcome:** Did not work
    - **Why:** Pi returns `success: false` answers to its caller as ordinary results. A `rejected`
      transport kind would force Pi to catch and unwrap it again, and would blur "the host answered"
      with "the transport failed", which is the distinction that decides relay replay.
  - **Attempt:** Keep the `rejected` kind MCP-side: the shared client resolves the raw answer and
    `mcp.ts` throws its own `HostRejectedError` (`kind: 'rejected'`, host message verbatim) for
    `success: false`. `mcp.ts` also keeps its stricter check that `success` is a boolean.
    - **Outcome:** Worked
    - **Why:** Existing MCP tests pass unchanged, and neither caller has to undo the other's policy.
  - **Attempt:** Map the shared client's "not a JSON object" message to MCP's "malformed response"
    by string matching.
    - **Outcome:** Did not work
    - **Why:** It would be brittle. Instead the shared message now reads
      `returned a malformed response that is not a JSON object`, which satisfies both callers'
      existing tests and is clearer.
- **Root cause:** The transport logic lived in two places. The Pi fix could not touch `mcp.ts`
  because the MCP classification was still unmerged in another worktree at the time.
- **Resolution:** `mcp.ts` calls `sendIpcRequest` and `describeIpcFailure` from `src/ipc-client.ts`
  with its relay hint `set CHROME_CONTROLLER_ALLOW_RELAY=1 or HTTP_PORT`. MCP-only policy stays in
  `mcp.ts`: the native-only (sensitive) unavailable message, the boolean-`success` check, and
  `HostRejectedError`. Errors that are not `IpcError` (invalid timeout, unserializable payload) are
  rethrown as-is instead of being labelled transport failures.
- **Verification:** `npm test` (252 pass), `npm run typecheck`, `npm run lint`, `npm run build`. The existing IPC tests in
  `src/mcp.test.ts` were not modified.
- **Prevention/follow-up:** `AGENTS.md` now says `src/ipc-client.ts` is the only IPC client.
  Behaviour this refactor deliberately preserves, left for follow-up: the IPC payload is
  `{ action, ...params }`, so a `params.action` key overrides the action (the relay path uses
  `{ ...params, action }`; no caller does this today); `{ success: false, error: '' }` surfaces an
  empty message; the MCP server does not pass the request's abort signal to `sendIpcRequest`,
  although the shared client supports it.
- **Reusable learning:** When a fix has to land in one copy of duplicated transport code, merge the
  copies next, before other work starts on the second copy. Keep caller policy (what a
  `success: false` answer means) in the caller, and keep only transport facts in the shared module.
- **References:** `src/ipc-client.ts`, `src/mcp.ts`, `src/mcp.test.ts`,
  `docs/leanings/2026-09-23-pi-extension-replayed-delivered-ipc-requests-over-the-relay.md`.
