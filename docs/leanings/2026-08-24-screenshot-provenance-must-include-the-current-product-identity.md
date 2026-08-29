# 2026-08-24 — Screenshot provenance must include the current product identity


- **Status:** Resolved
- **Task/context:** Rename the extension before uploading the corrective Web Store package.
- **Unexpected observation or failure:** The ZIP and promotional tiles used the new name while the required live screenshot still visibly showed the former name, yet the existing provenance test passed.
- **Evidence:** The screenshot hash matched its sidecar, but the sidecar recorded only capture mechanics and dimensions; it did not identify the manifest name, manifest version, or demo HTML that had been captured.
- **Approaches tried:**
  - **Attempt:** Keep the old screenshot because it was an authentic runtime capture.
    - **Outcome:** Rejected approach
    - **Why:** Authentic but stale branding contradicts the current package and can mislead store reviewers.
  - **Attempt:** Bind capture provenance to the manifest identity and exact generated demo HTML, then recapture through the reloaded extension.
    - **Outcome:** Worked
    - **Why:** Tests now reject both stale branding and stale demo content while preserving proof that the image came from the live extension.
- **Root cause:** Screenshot provenance established how an image was captured but not which product identity and generated page it represented.
- **Resolution:** Added manifest name, manifest version, and demo HTML SHA-256 to the capture sidecar and asserted them against current sources.
- **Verification:** The strengthened test failed against the prior screenshot, then passed after a fresh live capture visibly showed `p agent extension` in both the page header and HUD tab title.
- **Prevention/follow-up:** Regenerate and recapture all store media after any product-name, version, or demo-content change.
- **Reusable learning:** Media provenance must bind runtime evidence to the current product identity and source content, not only to image bytes and capture dimensions.
- **References:** `scripts/capture-store-screenshot.js`, `src/store-assets.test.ts`, `store-assets/screenshot-capture.json`
