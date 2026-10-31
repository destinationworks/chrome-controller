# 2026-10-31 — Admission tests passed with their checks removed

- **Status:** Resolved
- **Task/context:** Adversarial review of the merged guarded-target admission change (`preflightSecretTarget` in `Chrome Extension/background.js`, `docs/leanings/2026-10-29-admit-guarded-target-before-secret-operation.md`).
- **Unexpected observation or failure:** The four admission worker tests passed with `protectedTabStateUnavailable` removed from the post-await check, and with both `sensitiveActionDepth > 0` checks removed.
- **Evidence:** Reviewer mutation runs against the merged tests. The "persistence becomes unavailable" test triggered its failure with a second guarded action, which also bumps `outputLockEpoch`, so the epoch comparison alone rejected admission. The post-await depth check was unreachable: every increment of `sensitiveActionDepth` also increments `outputLockEpoch`, and the entry check already required depth 0.
- **Approaches tried:**
  - **Attempt:** Remove each check in turn and rerun the admission tests.
    - **Outcome:** Did not work for three of the checks (tests stayed green).
    - **Why:** A broader invariant (the epoch bump) satisfied each test by itself.
  - **Attempt:** Drive each check through the one path that bypasses the epoch: a pending admission while storage writes start failing and a tab-removed release cannot persist (state flips, no bump); a guarded action held in flight when the preflight arrives (depth above zero at entry, no read of the target tab).
    - **Outcome:** Worked.
    - **Why:** Removing `protectedTabStateUnavailable`, the entry depth check, or the epoch check now fails exactly one test each.
- **Root cause:** Tests exercised the state change through a path that also tripped an overlapping guard, so they could not tell the guards apart.
- **Resolution:** Two worker tests added; the unreachable post-await depth check deleted; the user guide no longer claims an inaccessible (unscriptable) tab is refused without being closed, because admission only proves the tab exists in this profile.
- **Verification:** Mutation runs on the three remaining admission checks each fail one named test; the full gate results are in the PR.
- **Prevention/follow-up:** The secure-clipboard client in the sibling repository uses a fixed 15 s response timeout, below the 47 s budget the host now needs; tracked outside this repository.
- **Reusable learning:** When several guards overlap, a passing test proves nothing until each guard is removed in isolation and the test fails. Build the failing input so only the guard under test can reject it.
- **References:** `src/extension-background.test.ts` (target admission tests), `Chrome Extension/background.js` (`preflightSecretTarget`), `docs/user-guide.md` (Guarded target admission and quarantine).
