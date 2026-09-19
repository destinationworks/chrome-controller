# 2026-09-20 — Relay pairing revocation must close the old transport

- **Status:** Resolved
- **Task/context:** Security re-review of per-instance relay pairing and WebSocket fallback.
- **Unexpected observation or failure:** Clearing or rotating session pairing metadata left an already-open WebSocket usable, so the old trusted relay could continue issuing commands.
- **Evidence:** The actual background worker accepted `relayConfigUnavailable`, reported no pairing metadata, then still executed a command received on the old socket.
- **Root cause:** Pairing state and transport lifecycle were updated independently.
- **Resolution:** Increment a pairing generation on revoke or rotation, detach and close the previous socket, bind every socket callback and response to the active socket plus generation, and keep fallback disabled without current pairing.
- **Verification:** Worker regression tests revoke an open relay, invoke a queued old message handler, verify no browser command runs, and verify reconnect remains disabled.
- **Prevention/follow-up:** Treat credential rotation as transport invalidation, not only metadata replacement.
- **References:** `Chrome Extension/background.js`, `src/extension-background.test.ts`
