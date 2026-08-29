# 2026-08-24 — Dead cookie actions outlived their manifest permission


- **Status:** Resolved
- **Task/context:** Repackage the extension after reducing its Chrome Web Store permissions.
- **Unexpected observation or failure:** The background request dispatcher still exposed cookie read/write/remove actions even though the manifest did not grant `cookies`, so those paths could only fail at runtime and made the permission audit incomplete.
- **Evidence:** A focused regression test found `chrome.cookies` plus the `getAllCookies`, `setCookie`, and `removeCookie` action names in `background.js` while confirming `cookies` was absent from the manifest.
- **Approaches tried:**
  - **Attempt:** Add the `cookies` permission to make the dormant actions work.
    - **Outcome:** Rejected approach
    - **Why:** No current product path or test exercised cookie control, and adding access to sensitive browser data would violate least privilege.
  - **Attempt:** Remove the three dead dispatcher branches.
    - **Outcome:** Worked
    - **Why:** It aligns reachable implementation with the reviewed manifest without expanding privileges.
- **Root cause:** API handlers and manifest permissions had drifted independently.
- **Resolution:** Deleted the unused cookie actions and added a manifest regression asserting that no cookie action remains without the permission.
- **Verification:** `src/manifest.test.ts` failed before the deletion and passes afterward; the packaged background script is also checked for cookie API/action strings.
- **Prevention/follow-up:** Treat manifest permission removal as a two-sided change: audit both granted APIs and dormant handlers that would require them.
- **Reusable learning:** Least-privilege review must reconcile the manifest with every externally reachable dispatcher action, not only currently advertised features.
- **References:** `Chrome Extension/background.js`, `Chrome Extension/manifest.json`, `src/manifest.test.ts`
