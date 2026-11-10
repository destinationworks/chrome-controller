# 2026-11-11 — A port probe cannot prove a test server closed on a shared CI host

- **Status:** Resolved
- **Task/context:** `src/store-authorize.test.ts` checked that `authorize()` closes its loopback server by fetching the server's URL afterwards and expecting ECONNREFUSED (PR #18).
- **Unexpected observation or failure:** CI run 42831730493 (head 0f29f5c) failed one test, "authorization runs the PKCE loopback flow…", at "the loopback server is closed once the code arrived": the probe did not see a refused connection. The same commit passed locally on macOS.
- **Evidence:** 5 of 5 runs passed in Linux Docker (Node 24.18). A probe that repeated the flow 300 times got ECONNREFUSED from both `fetch` and a raw TCP connect every time, on Linux and macOS, so a stale keep-alive socket in fetch's pool was not the cause. A mutation that removes `server.close` makes the new server-object check fail three tests.
- **Approaches tried:**
  - **Attempt:** Replace the fetch probe with a raw TCP connect.
    - **Outcome:** Did not work
    - **Why:** It still probes a port that something else may own by then; the probe data showed fetch was not the problem.
  - **Attempt:** Capture the server `authorize()` starts (spy on `http.Server.prototype.listen`) and assert `listening === false` with zero connections.
    - **Outcome:** Worked
    - **Why:** It inspects the server itself and does not depend on what else runs on the host.
- **Root cause:** Leading hypothesis, not directly observed: the freed ephemeral port was bound again before the probe ran. The CI host runs several runners, and `node --test` runs the test files in parallel processes that open their own listeners. Missing evidence: which process held the port at that moment.
- **Resolution:** The loopback tests check the captured server object; no test probes a freed port.
- **Verification:** `src/store-authorize.test.ts` passes locally, and removing `server.close` from `scripts/store-oauth.js` fails three tests; CI reruns on the pushed head.
- **Prevention/follow-up:** None beyond the test change.
- **Reusable learning:** To prove a server closed, assert on the server object (`listening`, `getConnections`), never on whether its old port refuses connections.
- **References:** `src/store-authorize.test.ts` (`runAuthorize`, `stopped`), CI run 42831730493.
