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

Flags combine and run in the order listing, upload, submit. With `--upload` or `--submit`,
credentials and the version are checked before the console is touched:

```bash
op run --env-file=.env.store -- npm run store:publish -- --listing --upload --submit
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

On the first `--diff`, `--listing` or `--inspect` run, sign in to that Chrome window with
the Google account that owns the item. Google asks it to "Verify it's you" again from time to time; the
run waits up to ten minutes for you to do that in the same window.

The field labels in `scripts/store-console.js` must match the console. A label that does
not match exactly one control stops the run before anything is written; run `--inspect` and
update the labels.

### Package and review: API credentials

1. In Google Cloud, create or pick a project and enable the **Chrome Web Store API**.
2. Configure the OAuth consent screen and set the app to **In production**. A consent
   screen left in Testing issues refresh tokens that expire after seven days. An unverified
   app is fine: the API is meant for the developer's own items.
3. Create an OAuth client of type **Web application** with the redirect URI
   `https://developers.google.com/oauthplayground`.
4. In the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), choose
   "Use your own OAuth credentials", authorize the scope
   `https://www.googleapis.com/auth/chromewebstore` with the account that owns the item, and
   exchange the code for tokens.
5. Store the client ID, client secret and refresh token in a 1Password item, copy
   `.env.store.example` to `.env.store`, and point its references at that item.

The script reads the credentials from the environment and never prints them.

## A release

1. Bump the version in `Chrome Extension/manifest.json`, update "What's new" in the listing
   file, and merge.
2. `npm run store:publish -- --diff` and read the differences and the package digest.
3. `op run --env-file=.env.store -- npm run store:publish -- --listing --upload --submit`.
4. Review and public availability follow later; the final status line shows the submitted
   state, not publication.
