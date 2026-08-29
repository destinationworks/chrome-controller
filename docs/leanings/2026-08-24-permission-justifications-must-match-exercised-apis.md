# 2026-08-24 — Permission justifications must match exercised APIs


- **Status:** Resolved
- **Task/context:** Audit the permissions shown in the Chrome Web Store privacy form before repackaging version 1.1.0.
- **Unexpected observation or failure:** The manifest requested `scripting`, `activeTab`, and `storage`, but the extension never called those APIs or used an action/context-menu/command gesture that could grant `activeTab`. The storage justification also claimed persistence that existed only as in-memory content-script state.
- **Evidence:** Repository-wide API search found zero `chrome.scripting` and zero `chrome.storage` calls. Runtime code directly exercises `chrome.debugger`, `chrome.tabGroups`, `chrome.alarms`, `chrome.runtime.connectNative`, and privileged tab metadata. Static content scripts match `<all_urls>` to provide arbitrary-page HUD and interaction support.
- **Approaches tried:**
  - **Attempt:** Keep all permissions and improve only the dashboard prose.
    - **Outcome:** Rejected approach
    - **Why:** A justification cannot make an unused permission comply with least-privilege requirements.
  - **Attempt:** Remove all broad access, including `<all_urls>`.
    - **Outcome:** Rejected approach
    - **Why:** The current no-click local-agent architecture needs content scripts on arbitrary target pages; replacing this with optional grants would require a separate consent-flow redesign.
  - **Attempt:** Remove only the three unused named permissions and retain the permissions tied to concrete runtime paths.
    - **Outcome:** Worked
    - **Why:** It reduces privilege without changing current functionality.
- **Root cause:** Permission metadata drifted from the implementation while the extension moved to static content scripts and debugger-based execution.
- **Resolution:** Removed `scripting`, `activeTab`, and `storage`; added `src/manifest.test.ts` to lock the reviewed permission set and packaged content-script declaration.
- **Verification:** The regression test failed with the old manifest, then passed after the removal. Full package validation verifies the resulting ZIP manifest.
- **Prevention/follow-up:** Re-audit code usage and permission justifications together whenever a Chrome API or content-script strategy changes.
- **Reusable learning:** Justify permissions by the capability they uniquely grant, not by generic operations such as creating tabs that do not require them.
- **References:** `Chrome Extension/manifest.json`, `src/manifest.test.ts`
