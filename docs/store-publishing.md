# Publishing to the Chrome Web Store

`npm run store:publish` publishes the extension and its listing from the repository. The
listing text lives in [`chrome-web-store-listing.md`](chrome-web-store-listing.md); the
package is built from the committed `Chrome Extension/` folder.

| Step | Flag | How it works |
| --- | --- | --- |
| Check | none | Validates the listing against the manifest and builds the package. No browser, no network; safe for CI. |
| Compare | `--diff` | Also opens the console and lists the text fields that differ from the listing file. Writes nothing. |
| Listing text | `--listing` | Fills the console's Store listing and Privacy practices text fields, saves each changed tab as a draft, reloads it and checks the saved text. |
| Package | `--upload` | Uploads the ZIP through the Chrome Web Store API V2. Refuses a version that is not newer than the published one. |
| Review | `--submit` | Submits the item for review through the API (`blockOnWarnings`), then fails unless the store reports a submitted state and the package version. |
| Layout | `--inspect` | Lists the console's form controls, for fixing the field map after Google changes the console. Runs alone. |
| Sign-in | `--sign-in` | Opens the publisher profile as plain Chrome for the one-time Google sign-in. Runs alone. |
| API access | `--authorize` | Runs Google's consent flow for the API, checks the new token can read the item, and saves its refresh token in the Keychain. Runs alone. |

Flags combine and run in the order listing, upload, submit. With `--upload` or `--submit`,
credentials and the version are checked before the console is touched:

```bash
npm run store:publish -- --listing --upload --submit
```

Every console field on both tabs is located before any is written, so a changed layout
stops the run with nothing saved. The package is built with `git archive` from the
committed `Chrome Extension/` folder, stamped with the commit time, and checked file by file
against the commit; its SHA-256 is printed before upload and is the same on every machine
for the same commit and git version.

## What the script does not change

- **Summary.** The console has no summary field; it shows the package manifest's
  `description`. The script refuses to run when the listing summary and the manifest differ,
  so a new summary always ships with a new package.
- Screenshots and promotional images, visibility, distribution, the remote-code answer,
  data-usage checkboxes and certifications. Change these in the console by hand.

## One-time setup

### Listing text: the publisher Chrome profile

Chrome does not let extensions script Web Store pages, the Developer Console included, so
Chrome Controller cannot fill the listing. The script starts Google Chrome with its own
profile in `~/.chrome-controller/store-publisher-profile` and drives it over the DevTools
protocol on 127.0.0.1. Your everyday profile is not touched. Any local process could use
that DevTools port while it is open, so the script closes this Chrome when the run ends.

Google refuses to sign in inside a browser driven over DevTools ("signin/rejected"), so sign
in once with `npm run store:publish -- --sign-in`. It opens the same profile as plain Chrome
on the console. Sign in with the account that owns the item, wait for the console to show the
item, then quit that Chrome with Cmd+Q. Later runs reuse the saved session. When Google asks
to "Verify it's you" again, the run waits up to ten minutes in its window; if Google rejects
that sign-in too, repeat `--sign-in`.

The field labels in `scripts/store-console.js` must match the console. A label that does
not match exactly one control stops the run before anything is written; run `--inspect` and
update the labels.

### Package and review: API credentials

The API steps read three values from the macOS login Keychain, service
`chrome-controller-store-api`: `client_id`, `client_secret` and `refresh_token`. When
`CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` and `CWS_REFRESH_TOKEN` are set, they are used
instead (CI, or `op run --env-file=.env.store` from `.env.store.example`); set all three or
none. The script never prints the client secret or the refresh token.

1. Create or pick a Google Cloud project and enable the Chrome Web Store API:
   `gcloud services enable chromewebstore.googleapis.com --project <project>`.
2. In Google Auth Platform, create the branding: an app name, your support and contact
   email, and the **External** audience. Then fill **Application home page**, **Application
   privacy policy link** and an **Authorised domain** (the repository's GitHub URLs and
   `github.com` work): Google keeps **Publish app** disabled until these are set. Publish
   the app so Audience reads **In production**. An app left in Testing gets refresh tokens
   that expire after seven days. An unverified app is fine: the API is meant for the
   developer's own items.
3. Create an OAuth client of type **Desktop app**. Google shows its secret only once, in the
   creation dialog. Store the ID and the secret; with `-w` last, `security` prompts for each
   value, so neither lands in shell history or the process list:

   ```bash
   security add-generic-password -U -s chrome-controller-store-api -a client_id -w
   security add-generic-password -U -s chrome-controller-store-api -a client_secret -w
   ```

4. Run `npm run store:publish -- --authorize` and open the URL it prints in a browser
   signed in as the item owner (the publisher profile is). Pick the account, continue past
   "Google hasn't verified this app" (Advanced, then Go to the app), and allow access.
   Google returns the browser to a one-time server on 127.0.0.1, and the script exchanges
   the code with PKCE. It checks that the new token can read the item, and only then saves
   the refresh token in the Keychain. Run it again whenever Google revokes the token.

## A release

1. Bump the version in `Chrome Extension/manifest.json`, update "What's new" in the listing
   file, and merge.
2. `npm run store:publish -- --diff` and read the differences and the package digest.
3. `npm run store:publish -- --listing --upload --submit`.
4. Review and public availability follow later; the final status line shows the submitted
   state, not publication.
