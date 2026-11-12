# 2026-11-12 — Node's "fetch failed" hides the reason in `error.cause`

- **Status:** Partial
- **Task/context:** The user reran `npm run store:publish -- --listing --upload --submit`; it printed the package lines and then only "fetch failed".
- **Unexpected observation or failure:** Neither the failing call (token refresh or status read) nor the reason (DNS, refused connection, TLS, proxy) was visible, so the failure could not be diagnosed afterwards.
- **Evidence:** Node's fetch (undici) rejects with `TypeError: fetch failed` and keeps the system error in `error.cause` (for example `getaddrinfo ENOTFOUND host`, code `ENOTFOUND`). `main()` printed `error.message` only. The same calls succeeded from the same machine minutes later, and `curl` reached both Google hosts.
- **Approaches tried:**
  - **Attempt:** Re-run the calls and print `error.cause`.
    - **Outcome:** Partial
    - **Why:** They succeeded, so the original reason is lost.
  - **Attempt:** Wrap every API request (`send` in `scripts/store-api.js`, also used by the authorization code exchange) so a rejected fetch becomes "<call> could not reach <host>: <cause message> (<code>)", keeping the original as `cause` and never including the request.
    - **Outcome:** Worked
    - **Why:** The message now names the call, the host and the system reason.
- **Root cause:** Unknown for the 2026-11-12 failure: the reason was discarded. Most likely a passing network or DNS failure, since nothing changed and the next attempt worked.
- **Resolution:** Network failures in the store scripts now carry the call, host and reason.
- **Verification:** "a network failure names the call, the host and the reason instead of a bare \"fetch failed\"" (`src/store-publish.test.ts`) and "a network failure during the code exchange names the call and the reason" (`src/store-authorize.test.ts`) failed before the fix and pass after it.
- **Prevention/follow-up:** If the failure recurs, the new message will show its reason; record it in a follow-up learning.
- **Reusable learning:** When reporting a Node fetch rejection, print `error.cause.message` and `error.cause.code`, not just `error.message`.
- **References:** `scripts/store-api.js` (`send`), `scripts/store-oauth.js`.
