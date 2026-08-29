# 2026-08-24 — Store screenshots must come from the running extension


- **Status:** Resolved
- **Task/context:** Adversarially review replacement media before resubmitting Chrome Controller.
- **Unexpected observation or failure:** A polished local rendering reused the real HUD CSS but manually assembled HUD markup, so it did not prove the extension itself produced the visible state.
- **Evidence:** Independent review compared the draft with Google's requirement that screenshots demonstrate the actual user experience. The local bridge initially reported `extensionConnected: false`, and automated navigation to `chrome://extensions` was correctly blocked.
- **Approaches tried:**
  - **Attempt:** Submit the deterministic HUD mockup because it matched the current stylesheet.
    - **Outcome:** Rejected approach
    - **Why:** Matching styles is not execution evidence and could repeat the irrelevant-media rejection.
  - **Attempt:** Ask the user only for a manual desktop screenshot.
    - **Outcome:** Partial
    - **Why:** It could prove the UI but would be inconsistent and risk exposing private tabs.
  - **Attempt:** Serve neutral local content, drive it through the connected unpacked extension, invoke real snapshot/click/CDP actions, and capture the resulting page with the real HUD.
    - **Outcome:** Worked
    - **Why:** It exercises the same background/content-script path as normal operation while keeping the page content safe and reproducible.
- **Root cause:** The first replacement workflow treated visual fidelity as equivalent to runtime evidence.
- **Resolution:** Added `scripts/capture-store-screenshot.js`; `npm run generate-store-assets` now generates brand artwork and then fails closed unless it can capture the real connected extension. Synthetic drafts were removed from upload-ready assets.
- **Verification:** The real 1280 × 800 JPEG visibly contains the extension-injected frame, tagged control, cursor ripple, expanded HUD, tab identity, coordinates, and action feed; the temporary demo tab is removed by exact tab ID.
- **Prevention/follow-up:** Keep deterministic promo rendering separate from the real screenshot capture. Never publish a screenshot produced solely from reconstructed extension markup.
- **Reusable learning:** For store review, authentic runtime state matters more than a visually accurate mockup; capture the real extension on sanitized content.
- **References:** `scripts/capture-store-screenshot.js`, `store-assets/screenshot-1280x800.jpg`
