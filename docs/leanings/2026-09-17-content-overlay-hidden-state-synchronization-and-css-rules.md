# 2026-09-17 — Content script overlay hidden state synchronization and missing CSS rules

- **Status:** Resolved
- **Task/context:** Investigating and fixing a bug where clicking the "Hide overlay" checkbox in the Chrome Controller extension HUD did not hide the overlay on the controlled page.
- **Unexpected observation or failure:** Checking the "Hide overlay" checkbox inside the floating HUD had no visible effect: the cyan viewport frame, simulated cursor, sparkles, ripples, keybursts, and interactive element badges remained completely visible on the web page.
- **Evidence:**
  - `Chrome Extension/content.js` defined `setOverlayHidden(hidden)` which toggled `.chrome-controller-hidden-overlay` on `#chrome-controller-overlay-root`.
  - Static search across `Chrome Extension/content.css` revealed zero rules referencing `.chrome-controller-hidden-overlay`.
  - In a live Playwright reproduction test (`src/content-overlay.test.ts`), toggling `.chrome-controller-hide-toggle` asserted `getComputedStyle(frame).display === 'none'`, which failed with `'block' !== 'none'`.
- **Approaches tried:**
  - **Attempt:** Set `root.style.display = 'none'` when hidden.
    - **Outcome:** Rejected approach.
    - **Why:** The HUD containing the "Hide overlay" checkbox is a child of the overlay root; setting `root.style.display = 'none'` destroys the HUD completely, making it impossible for the user to ever uncheck "Hide overlay" and unhide the controller without refreshing the page.
  - **Attempt:** Keep the HUD visible at 0.35 opacity when overlay is hidden to allow UI unchecking.
    - **Outcome:** Rejected approach.
    - **Why:** The collapsed HUD sits at `top: 18px; right: 18px` and expands on hover, directly blocking common website controls (user profiles, avatar menus, sign-in buttons, navigation dropdowns) located in the top-right corner of almost all modern web pages.
  - **Attempt:** Set `#chrome-controller-overlay-root.chrome-controller-hidden-overlay, * { display: none !important; }` combined with a global `Alt+O` (or Option+O) keyboard shortcut and draggable HUD positioning.
    - **Outcome:** Worked.
    - **Why:** When hidden, the overlay takes 0x0px, intercepts zero pointer events, and completely unblocks all website controls. The user can toggle visibility anytime via `Alt+O` (clearly badged in the settings UI), or drag the HUD away from top-right controls when visible.
  - **Attempt:** Keep state purely in-memory in `content.js`.
    - **Outcome:** Partial.
    - **Why:** Cross-origin page navigations in a controlled tab reload `content.js`, resetting `overlayHidden` to false and causing the overlay to reappear unexpectedly.
  - **Attempt:** Synchronize `overlayHidden` with `Chrome Extension/background.js` via runtime messages and pass it in `setControllerState`, supplemented by origin-scoped `sessionStorage` caching with `try/catch` guards.
    - **Outcome:** Worked.
    - **Why:** Overlay hidden preference survives both in-origin reloads and cross-origin navigations across the entire session, without throwing `SecurityError` on sandboxed/opaque origins.
- **Root cause:**
  1. Commit `28ef1ba` refactored `content.js` to toggle `.chrome-controller-hidden-overlay` instead of mutating inline styles, but omitted the corresponding CSS rules in `content.css`.
  2. Fixed positioning at `top: 18px; right: 18px` collided with common website header and profile menu controls.
  3. `wireOverlayControls` did not initialize `hideToggle.checked = Boolean(state.overlayHidden)`.
  4. `content.js` did not synchronize overlay hidden state with `background.js` or cache it in `sessionStorage`.
  5. HUD click and mousedown events were bubbling to the underlying webpage's event listeners.
- **Resolution:**
  - Applied `display: none !important` to `#chrome-controller-overlay-root.chrome-controller-hidden-overlay` and all descendants, completely freeing up the top-right corner and all website controls when hidden.
  - Wired global capture-phase `Alt+O` (Option+O on macOS) keyboard shortcut to toggle overlay visibility on/off at any time.
  - Added `<kbd class="chrome-controller-kbd">Alt+O</kbd>` shortcut badge to the HUD settings toggle.
  - Made the HUD header draggable (`.chrome-controller-status-row` drag handle) and persisted user-dragged position in `sessionStorage` so it stays wherever the user parks it.
  - Added `stopPropagation` on HUD click/mousedown to isolate HUD interaction from the host page.
  - Synchronized `overlayHidden` state across `content.js` and `background.js`, persisting across cross-origin navigations and tab sessions.
  - Added regression test suite in `src/content-overlay.test.ts` verifying complete DOM unblocking, pointer-event passthrough to underlying website buttons, `Alt+O` toggle cycles, HUD dragging, and storage persistence.
- **Verification:**
  - `src/content-overlay.test.ts` passed 100% in headless Chrome.
  - Full test suite passed (100 assertions, 16 suites) via `npm test`.
  - Typecheck passed clean (`tsc --noEmit`).
  - ESLint passed clean with `--max-warnings 0`.
- **Prevention/follow-up:** When building in-page extension overlays, never leave fixed pointer-capturing hitboxes in common website control zones (like the top-right corner) when hidden. Always pair overlay toggles with a non-intrusive global keyboard shortcut and provide draggable positioning.
- **Reusable learning:** When building browser extension HUDs, ensure "hide" completely removes all elements from display and hit-testing (`display: none !important`), provide an accessible global keyboard shortcut (`Alt+O`) for unhiding, allow dragging the HUD to custom corners, and synchronize preference state through the extension service worker so cross-origin navigations preserve user intent.
- **References:** `Chrome Extension/content.css`, `Chrome Extension/content.js`, `Chrome Extension/background.js`, `src/content-overlay.test.ts`
