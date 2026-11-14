# 2026-11-12 — A release rerun would have uploaded over the version under review

- **Status:** Resolved
- **Task/context:** After 1.3.2 was submitted with `npm run store:publish -- --listing --upload --submit`, the user ran the same command again.
- **Unexpected observation or failure:** The rerun stopped only because of a network failure. Had the API answered, it would have uploaded 1.3.2 again and submitted it a second time.
- **Evidence:** A status read right after the failed rerun showed "published 1.3.0, submitted 1.3.2 PENDING_REVIEW". The upload guard compared the package only with the published version (1.3.0), so 1.3.2 counted as newer and the run would have gone on to the console, the upload and the submit.
- **Approaches tried:**
  - **Attempt:** Treat a rerun as a silent no-op that exits 0.
    - **Outcome:** Did not work
    - **Why:** Rejected. A zero exit would claim a release that did not happen in this run, and it would hide a different pending version.
  - **Attempt:** Before anything is written, refuse `--upload` and `--submit` while the submitted revision is PENDING_REVIEW or STAGED. Say whether it is this version ("nothing to upload or submit") or another one ("wait for it to finish or cancel it").
    - **Outcome:** Worked
    - **Why:** It uses the status read the run already makes. REJECTED and CANCELLED submissions do not block a fix.
- **Root cause:** The version guard ignored the submitted revision.
- **Resolution:** `api.PENDING_STATES` and the precondition check in `scripts/store-publish.js`; documented in `docs/store-publishing.md` ("Rerunning step 3 is safe").
- **Verification:** Regression tests in `src/store-publish.test.ts` failed before the fix: "a rerun after the release refuses to upload or submit the version already under review" and "another version waiting for review or publication blocks a new upload until it is resolved". "a rejected or cancelled submission does not block a new upload" guards against blocking too much. A live rerun on 2026-11-12 found 1.3.2 already published and stopped at the published-version check, before Chrome or any write.
- **Prevention/follow-up:** None beyond the tests.
- **Reusable learning:** A publish step's precondition must account for every revision the store holds (published and submitted), so that rerunning a successful release cannot change anything.
- **References:** `scripts/store-publish.js`, `scripts/store-api.js` (`PENDING_STATES`), `src/store-publish.test.ts`.
