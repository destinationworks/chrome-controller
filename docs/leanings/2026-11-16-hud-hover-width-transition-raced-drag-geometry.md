# 2026-11-16 — HUD hover width transition raced drag geometry in headless Chrome CI

- **Status:** Resolved
- **Task/context:** Investigating the CI failure on `main` in `src/content-overlay.test.ts` (`browser: "hide overlay" checkbox and Alt+O completely remove HUD and overlay to unblock website controls`, GitHub Actions run `43631157413`).
- **Unexpected observation or failure:** Dragging `.chrome-controller-status-row` from near the right edge of the viewport (`left ~ 902`) toward `x = 100, y = 100` intermittently left `draggedHudPos.left` at `837` (failing `assert.ok(draggedHudPos.left < 500)`) or clicked `.chrome-controller-audio-btn` instead of starting a drag.
- **Evidence:** `.chrome-controller-hud` is anchored at `right: 18px` and transitions `width` from `42px` to `360px` over `160ms` on `:hover`. When Playwright moved the pointer to the center of `.chrome-controller-status-row` and pressed the mouse button while the `160ms` width transition was still in flight, either:
  1. The center of `.chrome-controller-status-row` coincided with `.chrome-controller-audio-btn`, which calls `e.stopPropagation()` on `mousedown` and is ignored by the drag handler (`if (e.target.closest('button')) return`), or
  2. `const rect = hud.getBoundingClientRect()` on `mousedown` captured an intermediate `rect.left` while the HUD was still expanding leftward from `right: 18px`.
- **Approaches tried:**
  - **Attempt:** Rely on `statusRow.hover()` alone before `mouse.down()`.
    - **Outcome:** Did not work
    - **Why:** `hover()` dispatches `mousemove` and resolves immediately without waiting for the 160 ms CSS `width` transition to finish, and the center of the expanded status row still overlaps the audio button.
  - **Attempt:** Add `.chrome-controller-dragging` to the overlay root during drag (`mousedown` through `mouseup`) with `transition: none !important` and locked expanded HUD dimensions in `Chrome Extension/content.css`, pin `hud.style.left`/`top` immediately on `mousedown`, and target the non-button `.chrome-controller-status-glyph` handle in `src/content-overlay.test.ts`.
    - **Outcome:** Worked
    - **Why:** Disabling CSS transitions on `mousedown` snaps the HUD to its final expanded box before `hud.getBoundingClientRect()` is read, eliminating mid-transition coordinate drift.
- **Root cause:** Reading `getBoundingClientRect()` on `mousedown` to convert a `right`-anchored element into `left`-anchored drag coordinates while a CSS `width` transition is active captures a transient `rect.left` and `rect.width`.
- **Resolution:** Added `.chrome-controller-dragging` in `Chrome Extension/content.js` and `Chrome Extension/content.css` to disable transitions and lock expanded dimensions before sampling `getBoundingClientRect()`, and updated `src/content-overlay.test.ts` and regenerated `store-assets/screenshot-1280x800.jpg` + `store-assets/screenshot-capture.json`.
- **Verification:** `npx tsx --test src/content-overlay.test.ts` and `npx tsx --test src/store-assets.test.ts` pass deterministically (`draggedHudPos.left < 200` and `sessionStorage` position persisted).
- **Prevention/follow-up:** None beyond the strengthened regression test in `src/content-overlay.test.ts`.
- **Reusable learning:** When converting a `right`- or `bottom`-anchored element to `left`/`top` coordinates on `mousedown` for dragging, disable CSS size/position transitions before reading `getBoundingClientRect()`, or mid-transition width changes will corrupt the initial drag offset.
- **References:** `Chrome Extension/content.js`, `Chrome Extension/content.css`, `src/content-overlay.test.ts`.
