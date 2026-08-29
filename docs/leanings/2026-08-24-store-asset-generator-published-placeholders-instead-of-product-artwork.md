# 2026-08-24 — Store asset generator published placeholders instead of product artwork


- **Status:** Resolved
- **Task/context:** Replace Chrome Web Store assets after version 1.1.0 was rejected for irrelevant media metadata.
- **Unexpected observation or failure:** The uploaded store icon and required screenshot were nearly blank dark rectangles even though the asset scripts also contained complete SVG logo markup.
- **Evidence:** The rejected 128 × 128 icon and 1280 × 800 screenshot contained only a cyan border and dark fill. The old PNG writers allocated raw pixel buffers and painted only background, border, and top-bar colors; they never rasterized the SVG logo or rendered product UI.
- **Approaches tried:**
  - **Attempt:** Consider appealing the rejection without changing media.
    - **Outcome:** Rejected approach
    - **Why:** The reviewer correctly identified media unrelated to observable functionality, so the submitted evidence did not support an appeal.
  - **Attempt:** Reload the unpacked extension through automated navigation to `chrome://extensions` for a live capture.
    - **Outcome:** Did not work
    - **Why:** Browser automation correctly blocks internal Chrome URLs; bypassing that boundary is not an acceptable capture path.
  - **Attempt:** Render the repository's vector mark and real HUD stylesheet with headless Chrome on a neutral local demo page.
    - **Outcome:** Worked
    - **Why:** It produces deterministic, upload-ready artwork that represents actual extension behavior without exposing private tabs or customer data.
- **Root cause:** The generators wrote placeholder raster pixels directly instead of rasterizing their SVG source or rendering actual Chrome Controller UI.
- **Resolution:** Replaced the raw placeholder writers with a Playwright/Chrome renderer, generated the extension icons from the canonical SVG, and created the required product screenshot and small promo tile plus an optional marquee tile from safe local content and the real HUD CSS.
- **Verification:** `src/store-assets.test.ts` checks required dimensions, formats, and minimum detail; direct full-resolution inspection confirmed the logo, UI copy, HUD, target badge, and cursor are visible and aligned.
- **Prevention/follow-up:** Keep upload-ready files in `store-assets/`, regenerate them with `npm run generate-store-assets`, and never use blank or generic media for store submission.
- **Reusable learning:** A valid image file and correct dimensions do not prove relevant store metadata; inspect the exact uploaded pixels and ensure screenshots visibly demonstrate actual functionality.
- **References:** `scripts/generate-store-assets.js`, `src/store-assets.test.ts`, `store-assets/README.md`
