# 2026-09-20 — Relay credentials must be instance-paired

- **Status:** Resolved
- **Task/context:** Security re-review of the loopback HTTP/WebSocket fallback in Chrome Controller.
- **Unexpected observation or failure:** The server, CLI clients, launcher, documentation, and extension shared one source-visible fallback key. Discovery files were written without an explicit private mode, and loopback requests trusted the socket address without validating Host or Origin.
- **Evidence:** Repository-wide search found the same key in every relay participant. Negative tests could connect with that public value and could supply non-loopback Host or Origin headers.
- **Approaches tried:**
  - **Attempt:** Require a manually configured key for every run.
    - **Outcome:** Partial
    - **Why:** Secure but unnecessarily breaks ordinary local startup and encourages keys in shell history.
  - **Attempt:** Generate one key per server instance and pair it over Native Messaging.
    - **Outcome:** Worked
    - **Why:** Preserves automatic local use without shipping a reusable credential.
- **Root cause:** Relay authentication was treated as a static application constant instead of per-instance secret state.
- **Resolution:** Generate a 32-byte random key when no explicit key is supplied; validate explicit key strength; atomically write validated discovery state to a `0600` file in a `0700` non-symlink directory; reject unsafe instance names, Host, Origin, and non-loopback client URLs; pair the extension through Native Messaging and session storage; stop logging keys.
- **Verification:** Server tests cover random-key uniqueness, weak-key rejection, discovery permissions, traversal, Host/Origin rejection, and native pairing. Production dependency audit reports zero advisories.
- **Prevention/follow-up:** Keep relay credentials out of source, logs, examples, process arguments, and long-lived browser storage.
- **Reusable learning:** Loopback binding is not authentication; local relays still need unguessable per-instance credentials plus Host/Origin validation.
- **References:** `src/discovery.ts`, `src/server.ts`, `src/native-host.ts`, `Chrome Extension/background.js`, `src/server.test.ts`
