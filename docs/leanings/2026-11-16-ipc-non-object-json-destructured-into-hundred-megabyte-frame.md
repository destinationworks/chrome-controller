# 2026-11-16 — Non-object JSON IPC lines were destructured into 100 MB Native Messaging frames

- **Status:** Resolved
- **Task/context:** Investigating a 15-second hang and ~100 MB binary stdout write during `src/native-host.test.ts` (`an IPC request line over the 10 MB cap is rejected without unbounded buffering`).
- **Unexpected observation or failure:** Sending a 10 MB valid JSON string literal (`"xxx...xxx"`) at the exact 10 MB line cap caused `startNativeHost()` to block the event loop for seconds, write ~100 MB of binary-framed JSON to `process.stdout`, and wait out the full 15 s `DEFAULT_CHROME_WAIT_MS` timeout before replying.
- **Evidence:** `JSON.parse(line)` succeeded on `"xxx...xxx"` and returned a 10,485,758-character string primitive. `const { action, id, ...params } = req` then spread every character index of the string into `params` (`{"0":"x","1":"x",...}`), producing a ~100 MB JSON object that was forwarded to `requestFromChrome(undefined, params)` and written to `process.stdout`.
- **Approaches tried:**
  - **Attempt:** Rely on `try { JSON.parse(line) } catch` alone to validate incoming IPC request lines.
    - **Outcome:** Did not work
    - **Why:** JSON primitives (`"string"`, `123`, `true`, `null`) and arrays (`[...]`) are valid JSON and pass `JSON.parse`, and object rest destructuring on strings or arrays copies every indexed element into `params`.
  - **Attempt:** Reject any parsed IPC value that is `null`, not `typeof === 'object'`, or `Array.isArray(parsed)` before destructuring, and reject requests without a non-empty string `action` before forwarding to Chrome.
    - **Outcome:** Worked
    - **Why:** Non-object JSON values and actionless objects are rejected immediately in `O(1)` without spreading indexed properties or touching `process.stdout`.
- **Root cause:** `src/native-host.ts` assumed `JSON.parse(line)` always returned a plain request object and destructured `...params` before checking the runtime type or `action` field.
- **Resolution:** Validated that parsed IPC requests are plain objects (`parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)`) and carry a non-empty string `action` (or valid batch array) before destructuring or forwarding to Chrome. Also bounded incoming Native Messaging stdio frame headers (`MAX_NATIVE_MESSAGE_BYTES = 64 * 1024 * 1024`) and buffered stdin chunks as a list instead of quadratic per-chunk `Buffer.concat`.
- **Verification:** Added regression tests in `src/native-host.test.ts` (`native host rejects non-object JSON IPC payloads and missing action without forwarding to Chrome` and `native host stdio frame parser rejects oversized frame length header instead of allocating multi-GB buffer`). The full `src/native-host.test.ts` suite now completes in ~1.2 s without writing to stdout on malformed payloads.
- **Prevention/follow-up:** Promoted the plain-object validation rule before rest-destructuring untrusted JSON to `AGENTS.md`.
- **Reusable learning:** Never rest-destructure (`const { ...rest } = parsed`) the result of `JSON.parse` before verifying `parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)`: spreading a large JSON string or array enumerates millions of index keys and amplifies payload size by an order of magnitude.
- **References:** `src/native-host.ts`, `src/native-host.test.ts`.
