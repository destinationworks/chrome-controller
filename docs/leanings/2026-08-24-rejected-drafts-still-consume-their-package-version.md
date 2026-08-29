# 2026-08-24 — Rejected drafts still consume their package version


- **Status:** Resolved
- **Task/context:** Upload the corrected package after Chrome Web Store rejected version 1.1.0 for listing media.
- **Unexpected observation or failure:** The dashboard returned only a generic upload error when given a corrected ZIP that still declared version 1.1.0.
- **Evidence:** The Package page already identified the rejected draft as version 1.1.0, and the replacement ZIP manifest also declared 1.1.0. Google's Web Store update documentation requires each uploaded replacement to have a version larger than the previous version.
- **Approaches tried:**
  - **Attempt:** Retry the byte-valid 1.1.0 ZIP.
    - **Outcome:** Did not work
    - **Why:** Repacking different bytes does not make an already-used manifest version eligible for upload.
  - **Attempt:** Increment all project and manifest version sources to 1.1.1 and rebuild.
    - **Outcome:** Worked
    - **Why:** The replacement package now has a monotonically higher version while keeping project metadata synchronized.
- **Root cause:** The corrective repack changed permissions and media workflow but did not increment the manifest version already registered by the rejected draft.
- **Resolution:** Bumped the manifest, package metadata, and lockfile root version to 1.1.1.
- **Verification:** A regression test first reproduced the stale-version condition, then passed after the bump; the rebuilt archive manifest and filename both report 1.1.1.
- **Prevention/follow-up:** Before producing any Web Store replacement, compare the dashboard's latest draft version with the package manifest and increment it even when the prior draft was rejected rather than published.
- **Reusable learning:** Chrome Web Store package versions are consumed by upload, not only by publication; every corrective ZIP needs a strictly higher manifest version.
- **References:** `Chrome Extension/manifest.json`, `package.json`, `src/manifest.test.ts`, https://developer.chrome.com/docs/webstore/update
