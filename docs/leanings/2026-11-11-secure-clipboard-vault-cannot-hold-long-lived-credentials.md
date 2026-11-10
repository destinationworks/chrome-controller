# 2026-11-11 — The secure-clipboard vault cannot hold long-lived credentials

- **Status:** Resolved
- **Task/context:** Choosing where the Chrome Web Store API client secret and refresh token live. The user first asked for "my cli secure vault tool".
- **Unexpected observation or failure:** The secure-clipboard MCP server, the user's secret-handling tool, keeps secrets only in process memory with a TTL of at most 86,400 seconds. A refresh token used months later would be gone after a day or after the server restarts, which happened during this task when the app was quit.
- **Evidence:** `secure-clipboard-mcp/src/vault.rs` starts "In-memory secure vault"; its tools cap `ttl_seconds` at 86400; the binary runs only as a stdio MCP server, with no CLI. The `dst-password-holder` project states it is not ready for real credentials.
- **Approaches tried:**
  - **Attempt:** Store the credentials in the secure-clipboard vault.
    - **Outcome:** Did not work
    - **Why:** Not durable.
  - **Attempt:** The macOS login Keychain through `security`, values on stdin only.
    - **Outcome:** Worked
    - **Why:** Durable and encrypted, unlocked with the user's session, with no extra prompts for items the `security` tool created. The user chose it over 1Password.
- **Root cause:** The vault is built to hand secrets between steps without exposing them, not to persist them.
- **Resolution:** Credentials live in the Keychain service `chrome-controller-store-api`; `CWS_*` variables still override it for CI or `op run`.
- **Verification:** Keychain writes are read back before use; a real temporary keychain test exercises `security` on macOS (`src/store-authorize.test.ts`).
- **Prevention/follow-up:** AGENTS.md names the Keychain service and warns that the vault forgets.
- **Reusable learning:** Use the secure-clipboard vault to move a secret between steps; put anything needed again later in the Keychain (or 1Password), never only in the vault.
- **References:** `scripts/store-credentials.js`, `AGENTS.md` (Chrome Web Store).
