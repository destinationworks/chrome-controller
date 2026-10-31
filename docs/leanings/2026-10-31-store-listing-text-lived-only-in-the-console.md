# 2026-10-31 — The published store listing existed only in the console

- **Status:** Resolved
- **Task/context:** Updating the Chrome Web Store listing for 1.3.2 and adding GitHub, Pi and p links (`docs/chrome-web-store-listing.md`).
- **Unexpected observation or failure:** The public store page did not match the repository's listing copy, and nobody could find the published wording. The homepage link had once returned 404.
- **Evidence:** The published description was written in a Codex session on 2026-08-23 and edited in the console on 2026-09-20. Both times it was pasted from chat, never saved to a file; it was recovered from the compressed session transcript. The repository copy (`bd907cc`, 2026-09-17) never reached the store because the item was in review. `destinationworks/chrome-controller` is private, so every GitHub link answers 404 to the public, and the repository has no license.
- **Approaches tried:**
  - **Attempt:** Search git history on every branch for the published phrases.
    - **Outcome:** Did not work.
    - **Why:** The text was never committed.
  - **Attempt:** Search Codex, Antigravity, p, Pi and Claude Code session stores.
    - **Outcome:** Worked.
    - **Why:** Codex keeps most transcripts zstd-compressed; `rg -z -l` silently skipped matches, so only full-read `rg -z -o` passes found them.
- **Root cause:** Listing text and Privacy practices answers were treated as console state rather than source, and links were added without checking that the repository was public.
- **Resolution:** The listing doc now holds every text field and Privacy practices answer, plus the recovered previous text. Tests check the console limits, the release-notes version, that GitHub links point at this repository, that the privacy policy file exists and that the install command registers the store item ID.
- **Verification:** `src/store-assets.test.ts` listing tests; they fail against the previous listing doc and against stale release notes.
- **Prevention/follow-up:** Make the repository public (after a history secret scan) and add a license before the listing calls the extension open source. Automate pasting from this file into the console so the console never holds the only copy.
- **Reusable learning:** Treat store listing text as source code: edit the file, then publish from it. Before linking a repository from a public listing, fetch the link without credentials.
- **References:** `docs/chrome-web-store-listing.md`, `src/store-assets.test.ts`, `docs/leanings/2026-08-24-permission-justifications-must-match-exercised-apis.md`.
