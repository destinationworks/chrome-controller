# 2026-09-23 — The IPC reader copied its buffer on every chunk, and both the first fix and its control experiment were wrong

- **Status:** Resolved
- **Task/context:** While adding the native host watchdog, the existing test `NativeMessagingHost IPC server rejects oversized lines exceeding 10MB` failed intermittently and took ~16s.
- **Unexpected observation or failure:** The test flaked about half the time with `Timeout waiting for socket termination`. Investigating it uncovered a far more serious defect underneath: the IPC read path copies its entire accumulated buffer on every chunk, so feeding a 10MB line copies ~6.4GB and blocks the event loop for seconds — the same wedge condition the watchdog exists to detect, reachable by any local process that can open the socket.
- **Evidence:**
  - Stashing all local changes and running the test twice on clean `main` reproduced the flake (pass, then fail), proving it predated this work.
  - Instrumented reader, 11MB fed over a unix socket: **1281 data events, max chunk 8192 bytes**. Kernel reads arrive in ~8KB pieces, not in the 1MB sizes the writer used.
  - Controlled comparison of the two readers on identical input:

    | reader | wall | bytes copied | handler CPU |
    | --- | --- | --- | --- |
    | concat per chunk | 4388ms | 6405MB | 3567ms |
    | chunk list, joined once | **38ms** | 0MB | **0ms** |
  - After the fix, `src/native-host.test.ts` runtime fell from ~16.6s to ~1.7s and the full suite from ~90s to ~25s.
- **Approaches tried:**
  - **Attempt:** Assume the flake came from the in-flight watchdog changes.
    - **Outcome:** Did not work
    - **Why:** A baseline run on stashed `main` reproduced it. Half of intermittent failures predate the change being blamed.
  - **Attempt:** Check the size cap *before* concatenating, leaving the concatenation itself in place.
    - **Outcome:** Did not work
    - **Why:** It removed exactly one final ~10MB copy out of ~6.4GB — 0.16% of the work. The quadratic cost is the per-chunk concatenation of *under-cap* data, which this left untouched. The accompanying code comment and learning entry both asserted a fix that measurement did not support.
  - **Attempt:** Validate that claim with a "plain `net` server with no host code", which took 7.8s for the same data.
    - **Outcome:** Did not work
    - **Why:** The control server contained the same per-chunk `Buffer.concat` as the code under test. It varied the wrong thing, so it measured the bug in both arms and produced a confident, wrong conclusion ("the slowness is environmental"). A control must differ in exactly the variable under test.
  - **Attempt:** Assert that the rejection completes within 3s.
    - **Outcome:** Did not work
    - **Why:** It measured client-side write-buffer flushing, which is nondeterministic, rather than the host's cap enforcement.
  - **Attempt:** Assert worst-case latency of a concurrent `hostPing` during a flood.
    - **Outcome:** Did not work
    - **Why:** Mutation testing exposed it: with the bug reintroduced the test still passed. Each individual copy is only milliseconds; the regression is cumulative, not per-request.
  - **Attempt:** Replace the accumulating buffer with a chunk list joined once per complete line, and assert the *total* time to absorb a 9MB flood.
    - **Outcome:** Worked
    - **Why:** It removes the quadratic term entirely, and the cumulative assertion is what the defect actually moves. Verified by mutation: the test fails at 8.1s against the reintroduced bug and passes at 1.0s against the fix.
- **Root cause:** Two independent issues sharing one symptom. The flake came from the test queueing 11MB into a client write buffer that could not flush once the server destroyed the socket. The performance defect was `lineBuffer = Buffer.concat([lineBuffer, chunkBuffer])` executing on every ~8KB kernel read, giving O(n²) copying on the event loop.
- **Resolution:** The reader now holds incomplete line fragments as an unmerged `Buffer[]` with a running length, scans only the newly arrived chunk for `0x0a`, and concatenates once when a line completes. The cap is enforced against the running length before any copy. The test was rewritten to be backpressure-aware, and a new test asserts a 9MB flood is absorbed in under 3s while `hostPing` stays responsive.
- **Verification:** `npm test` 194/194 pass. Both new tests mutation-tested against the reintroduced defect: the flood test fails (8.1s vs 1.0s) and the cap-boundary test covers exactly-at-cap acceptance and one-byte-over rejection. Suite runtime fell from ~90s to ~25s.
- **Prevention/follow-up:** None outstanding; the quadratic term is gone for both over-cap and legitimate large payloads.
- **Reusable learning:** Three rules, each earned here. Reproduce a suspected regression on a stashed baseline before blaming your own change. Make a control differ in exactly one variable — a control that shares the defect will confirm whatever you already believe. And mutation-test any test written to pin a performance or timing defect: assert the quantity the defect actually moves, because a plausible-looking assertion that passes against the bug is worse than no test.
- **References:** `src/native-host.ts` (IPC read path), `src/native-host.test.ts` (`IPC flood must not stall concurrent requests`, cap-boundary test).
