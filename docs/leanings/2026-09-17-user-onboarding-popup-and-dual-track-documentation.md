# 2026-09-17 — User onboarding popup and dual-track documentation

- **Status:** Resolved
- **Task/context:** Provide comprehensive documentation and in-browser onboarding for both Chrome Web Store end users and source/self-development developers.
- **Unexpected observation or failure:** The repository and extension had no user onboarding flow: clicking the extension icon did nothing because no `action` was declared, `manifest.json` lacked `homepage_url`, and `README.md` lacked a distinct guide separating official Web Store users from unpacked extension developers.
- **Evidence:** Users installing `gocbenlgkgeaiifofilndbnaeigpplca` from the Chrome Web Store had no visible UI to copy their ID, check bridge connection status, or access setup instructions. `src/manifest.test.ts` had no checks for user-facing entry points.
- **Approaches tried:**
  - **Attempt:** Only add documentation to `README.md`.
    - **Outcome:** Partial
    - **Why:** End users who install from the Chrome Web Store would still encounter a dormant extension icon without an action popup or direct link to the local bridge setup.
  - **Attempt:** Add `homepage_url`, a lightweight `action` popup (`popup.html`/`css`/`js`) querying background connection status, copyable `npm run install-host` commands, dual-track documentation (`README.md`, `docs/user-guide.md`), and Chrome Web Store console copy (`docs/chrome-web-store-listing.md`).
    - **Outcome:** Worked
    - **Why:** Closes the onboarding loop for both Web Store and local developers without requesting any new Chrome permissions (`manifest.permissions` remains strictly limited to `['tabs', 'debugger', 'tabGroups', 'alarms', 'nativeMessaging']`).
- **Root cause:** Initial development focused on headless AI agent integration and relay protocols, omitting the browser-native onboarding surface and dual-audience user documentation.
- **Resolution:** Declared `homepage_url` and `action` in `manifest.json`; created `popup.html`, `popup.css`, and `popup.js`; added `getConnectionState` handler to `background.js`; wrote comprehensive dual-track documentation and Web Store Developer Console copy; expanded `src/manifest.test.ts` to assert that all onboarding assets exist and are packaged.
- **Verification:** All 102 tests passed (`npm test`), TypeScript typecheck passed (`npm run typecheck`), ESLint passed with 0 warnings (`npm run lint`), and `dist/chrome-extension-v1.2.0.zip` was verified to include all new assets.
- **Prevention/follow-up:** Always pair companion extension development with a self-contained action popup that displays live connection diagnostics and setup commands.
- **Reusable learning:** Companion extensions for local AI tools must provide an informative action popup with connection status and copyable bridge setup commands so users are never left with a dormant extension icon.
- **References:** `Chrome Extension/manifest.json`, `Chrome Extension/popup.html`, `README.md`, `docs/user-guide.md`, `docs/chrome-web-store-listing.md`, `src/manifest.test.ts`.
