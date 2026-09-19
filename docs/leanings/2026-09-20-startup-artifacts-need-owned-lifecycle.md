# 2026-09-20 — Startup artifacts need an owned lifecycle

- **Status:** Resolved
- **Task/context:** Listener, discovery-file, and Native Messaging socket startup failure review.
- **Unexpected observation or failure:** Discovery write errors escaped the listener callback and left `ready` pending; cleanup from a failed same-name launch could delete a live instance's discovery record; Native Messaging startup could unlink a live Unix socket and did not reject `ready` on bind failure.
- **Evidence:** Integration tests reproduced discovery publication failure, a same-instance port collision, an active Unix socket collision, and an unexpected regular file at the socket path.
- **Root cause:** Readiness covered port binding but not secure metadata publication, while cleanup targeted shared paths by name rather than the artifact identity created by that launch.
- **Resolution:** Route publication errors through rejected readiness and partial-listener cleanup; remove discovery only when its exact contents match the publishing launch; probe an existing Unix socket before stale cleanup; refuse symlinks and unexpected files; remove sockets only when device and inode match the bound socket; propagate a closed/cancelled state across asynchronous socket preparation and binding; let `close()` directly reject any pending startup promise instead of depending on a later listener event.
- **Verification:** Tests confirm failed publication closes both listeners, failed second startup preserves the first record and listener, a second native host cannot disrupt the first, unexpected files are preserved, and microtask-timed `close()` before `listening` settles `ready` with rejection and leaves no socket.
- **Prevention/follow-up:** A process may clean up only artifacts whose identity it recorded after successful creation.
- **References:** `src/discovery.ts`, `src/server.ts`, `src/native-host.ts`, `src/server.test.ts`, `src/native-host.test.ts`
