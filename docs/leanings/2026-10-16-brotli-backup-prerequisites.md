# 2026-10-16 — Verify backup prerequisites before starting a build

- **Status:** Resolved
- **Task/context:** CTRL-RUNTIME-001, preserve installation evidence with Brotli Q6.
- **Unexpected observation or failure:** A Python backup helper failed because its interpreter had no Brotli module, while the following independent shell command still rebuilt generated bridge output.
- **Evidence:** Python returned `ModuleNotFoundError: No module named 'brotli'`; the subsequent TypeScript build completed. This is not evidence of a successful pre-build byte backup. Tracked sources and existing browser/session data were unchanged.
- **Approaches tried:**
  - **Attempt:** Assume the default Python interpreter supplies Brotli and put the build after it as an independent shell command.
    - **Outcome:** Did not work
    - **Why:** Neither the dependency nor successful backup completion had been enforced.
  - **Attempt:** Use Node's built-in zlib Brotli implementation at quality 6 and compare decompressed bytes before accepting a backup.
    - **Outcome:** Worked
    - **Why:** It requires no extra module; the native-host manifest backup was round-trip verified.
- **Root cause:** Unverified interpreter dependency plus missing success dependency between backup and mutation.
- **Resolution:** Use the available built-in compression runtime and gate each mutation on verified backup completion. Do not describe the failed pre-build attempt as a saved previous artifact.
- **Verification:** Native-host manifest compressed with quality 6, decompressed and compared byte-for-byte; checksum recorded privately. The prior generated build was not captured by the failed attempt.
- **Prevention/follow-up:** Keep dependencies and mutations sequential and fail closed when backup creation fails. Retain tracked source and an explicit supported installation rollback.
- **Reusable learning:** A backup command invocation is not a backup receipt; verify its bytes before the dependent action.
- **References:** `AGENTS.md` validation and preservation rules; Node `node:zlib` Brotli APIs.
