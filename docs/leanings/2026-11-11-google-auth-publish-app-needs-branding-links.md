# 2026-11-11 — Google Auth Platform keeps "Publish app" disabled until branding has its links

- **Status:** Resolved
- **Task/context:** Moving the Chrome Web Store API's OAuth app from Testing to In production, so its refresh token does not expire after seven days.
- **Unexpected observation or failure:** Right after the branding wizard (app name, support email, External audience, contact email), the Audience page said "To publish your app, you must complete your configuration on the Branding page", although the wizard had reported success.
- **Evidence:** The Branding page listed Application home page, Application privacy policy link and Authorised domains as empty. After filling the repository URL, `PRIVACY.md` on GitHub and the authorised domain `github.com`, "Branding changes saved" appeared and Publish app moved the status to "In production".
- **Approaches tried:**
  - **Attempt:** Publish straight after the wizard.
    - **Outcome:** Did not work
    - **Why:** The wizard does not ask for the home page, privacy link or authorised domain that publishing requires.
  - **Attempt:** Fill those three fields, save, then Publish app.
    - **Outcome:** Worked
    - **Why:** They are the prerequisites the Audience page referred to. No logo was uploaded, because a logo would require verification.
- **Root cause:** Google requires an External app's public links before it leaves Testing; the creation wizard skips them.
- **Resolution:** `docs/store-publishing.md` step 2 lists the three fields before Publish app.
- **Verification:** The Audience page reads "In production"; the consent screen then offered the unverified-app warning and the Chrome Web Store scope, and `--authorize` succeeded.
- **Prevention/follow-up:** None beyond the setup guide.
- **Reusable learning:** Before publishing a Google OAuth app, fill Branding's home page, privacy policy link and authorised domain; skip the logo unless you mean to verify.
- **References:** `docs/store-publishing.md`.
