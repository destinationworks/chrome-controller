# 2026-09-20 — Protected-tab state must survive worker restart

- **Status:** Resolved
- **Task/context:** Security re-review of guarded secret extraction across Manifest V3 service-worker and native-host restarts.
- **Unexpected observation or failure:** Protected tab IDs and expiry times existed only in a background-script `Map`. Chrome may terminate and recreate the service worker, which erased the guard while the page and native/relay transports remained available.
- **Evidence:** Loading the real background script in a fresh worker context reproduced an empty in-memory map despite an unexpired guard from the prior context.
- **Approaches tried:**
  - **Attempt:** Rely only on alarms to reconstruct the map.
    - **Outcome:** Partial
    - **Why:** Alarm persistence varies by Chrome version and is not a durable state record.
  - **Attempt:** Store only tab IDs and expiry timestamps in `chrome.storage.session`, with alarms used for cleanup.
    - **Outcome:** Worked
    - **Why:** Session storage survives worker termination without persisting secret material or exposing it to content scripts by default.
- **Root cause:** Manifest V3 service-worker lifecycle was treated like a persistent background page.
- **Resolution:** Reserve and persist a bounded 24-hour in-flight guard before page access, then replace that reservation with the requested post-completion TTL only after the action settles; restore guard metadata before processing messages or debugger events; fail closed if restoration or persistence fails; globally suppress browser output while any guard is active; never shorten a pre-existing expiry; make stale alarms re-check and re-arm against the current expiry; allow only the sensitive recovery close action when state is unavailable or another sensitive action is pending.
- **Verification:** The actual extension script is executed in a worker harness that restarts during an in-flight page evaluation, advances time past a one-second requested TTL while the action remains unresolved, verifies native and relay blocking after restart, verifies debugger-event suppression, rejects storage-write failure before debugger access, proves renewal plus stale alarms cannot shorten protection, and confirms recovery close still reaches `tabs.remove` during a hung sensitive action.
- **Prevention/follow-up:** Treat all security-relevant service-worker globals as caches of persisted state, never as the sole source of truth.
- **Reusable learning:** A security guard in an MV3 global variable is temporary; persist it before the protected side effect, restore it before any output path, and treat expiry callbacks as stale until they validate current state.
- **References:** `Chrome Extension/background.js`, `src/extension-background.test.ts`, `Chrome Extension/manifest.json`
