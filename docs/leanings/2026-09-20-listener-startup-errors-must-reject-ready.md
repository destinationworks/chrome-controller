# 2026-09-20 — Listener startup errors must reject ready

- **Status:** Resolved
- **Task/context:** Edge-case security and reliability testing of the optional loopback relay.
- **Unexpected observation or failure:** A blocked WebSocket or HTTP port emitted an asynchronous server error that was not connected to the server's readiness contract. Depending on timing and dependency behavior, callers could see an uncaught process error or a readiness wait that never completed.
- **Evidence:** The isolated port-conflict harness reproduced `EADDRINUSE` while the returned `ready` promise remained unresolved.
- **Approaches tried:**
  - **Attempt:** Depend on the process-level uncaught error.
    - **Outcome:** Did not work
    - **Why:** It crashes the process and gives callers no structured recovery path.
  - **Attempt:** Attach listener error handlers and reject `ready` with a sanitized descriptive error.
    - **Outcome:** Worked
    - **Why:** The owning launcher can close partial listeners and report a bounded startup failure.
- **Root cause:** Listener readiness covered only successful `listening` events and omitted the asynchronous error branch.
- **Resolution:** Handle HTTP and WebSocket server errors immediately, reject the readiness promise, stop the counterpart listener, avoid writing discovery on partial startup, and make the direct entry point close cleanly with a nonzero exit status.
- **Verification:** Subprocess tests occupy the requested port, assert a descriptive handled failure, assert the absence of an unhandled error event, and confirm the first server remains healthy.
- **Prevention/follow-up:** Every asynchronous listener factory must expose both success and failure through the same readiness contract.
- **Reusable learning:** A `ready` promise that cannot reject is not a complete server startup contract.
- **References:** `src/server.ts`, `test/port-conflict.test.ts`, `test/spawn-server.ts`
