# 2026-10-16 — Installed controller versions must be checked separately

- **Status:** Partial
- **Task/context:** CTRL-RUNTIME-001, verify the installed Chrome controller and Pi without losing open sessions.
- **Unexpected observation or failure:** Source and package reported 1.3.0, but Chrome loaded Store version 1.2.1 and six compiled bridge modules differed from a fresh build. Health and ordinary DOM controls passed while `chrome_type_text` failed.
- **Evidence:** A real Pi invocation returned `Batch item 1 specifies disallowed action "sendCommand"`; a separate real Pi run correctly filled Unicode text, selected a value, clicked once and read back the result. The running host retained its original PID after rebuilding.
- **Approaches tried:**
  - **Attempt:** Treat source version and health as runtime proof.
    - **Outcome:** Did not work
    - **Why:** Health does not exercise the input batch allowlist or identify loaded worker/host code.
  - **Attempt:** Compile to a separate output directory and compare modules, inspect Chrome's extension details, and exercise actual Pi tools.
    - **Outcome:** Worked
    - **Why:** These observations distinguish the four installation layers and reproduce the missing input path.
- **Root cause:** Source updates had not been followed by both bridge compilation and extension release/activation.
- **Resolution:** Rebuild the bridge and prepare the exact 1.3.0 browser package. Worker replacement and post-replacement Pi acceptance remain separate gates while this entry is Partial.
- **Verification:** Actual installed Pi 0.86.1, Native Messaging health, Unicode DOM flow and screenshot; separate-build comparison. These do not yet establish acceptance of a loaded 1.3.0 worker.
- **Prevention/follow-up:** Follow the runtime update checklist; record source, compiled files, host PID and worker version. Restart only after guarded-operation quiescence; hostPing does not expose all redaction-guard expiry state.
- **Reusable learning:** A healthy bridge and current source version do not prove current loaded browser behavior.
- **References:** `docs/user-guide.md#runtime-update-checklist`, `src/index.ts`, `src/native-host.ts`, `Chrome Extension/background.js`.
