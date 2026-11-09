#!/usr/bin/env node
// Publishes the extension and its listing to the Chrome Web Store from the repository:
//   npm run store:publish                     check: validate the listing and build the package
//   npm run store:publish -- --diff           also compare the console's text fields
//   npm run store:publish -- --listing        write the console's text fields and save drafts
//   npm run store:publish -- --upload         upload the package through the API
//   npm run store:publish -- --submit         submit the uploaded package for review
//   npm run store:publish -- --inspect        list the console's form controls (alone)
// Flags combine and run in the order listing, upload, submit. API steps need
// CWS_CLIENT_ID, CWS_CLIENT_SECRET and CWS_REFRESH_TOKEN (see docs/store-publishing.md).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseListing, validateListing } from './store-listing.js';
import * as api from './store-api.js';
import { buildPackage, isNewerVersion } from './store-package.js';
import * as consoleUi from './store-console.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = ['--diff', '--listing', '--upload', '--submit', '--inspect'];

export function parseArgs(argv) {
  for (const arg of argv) if (!FLAGS.includes(arg)) throw new Error(`Unknown option ${arg}; expected ${FLAGS.join(', ')}`);
  const options = Object.fromEntries(FLAGS.map((flag) => [flag.slice(2), argv.includes(flag)]));
  if (options.inspect && argv.length > 1) throw new Error('--inspect runs alone');
  return options;
}

async function withConsole(deps, work) {
  const { port } = await deps.startPublisherChrome();
  const browser = await deps.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = browser.contexts()[0] ?? await browser.newContext();
    return await work(await context.newPage());
  } finally {
    await deps.closePublisherChrome(browser).catch(() => {});
    await browser.close().catch(() => {});
  }
}

function tabName(tab) {
  return tab || 'store listing';
}

// Locates and reads every field on every tab before writing any, so a layout change stops
// the run with nothing saved. Each saved tab is reloaded and must read back the file's text.
async function syncConsole(deps, listing, write) {
  const { log } = deps;
  const fields = consoleUi.consoleFieldPlan(listing);
  const tabs = [...new Set(fields.map((field) => field.tab))];
  return withConsole(deps, async (page) => {
    const pending = [];
    for (const tab of tabs) {
      await deps.openConsoleTab(page, consoleUi.editUrl(listing, tab), { log });
      const changes = await deps.syncFields(page, fields.filter((field) => field.tab === tab), { dryRun: true, log });
      log(`${tabName(tab)} tab: ${changes.length === 0 ? 'matches the listing file' : `${changes.length} field(s) differ: ${changes.map((change) => change.label).join(', ')}`}`);
      if (changes.length > 0) pending.push(tab);
    }
    if (!write) return pending;
    for (const tab of pending) {
      const url = consoleUi.editUrl(listing, tab);
      const tabFields = fields.filter((field) => field.tab === tab);
      await deps.openConsoleTab(page, url, { log });
      await deps.syncFields(page, tabFields, { dryRun: false, log });
      await deps.saveDraft(page);
      await deps.openConsoleTab(page, url, { log });
      const unsaved = await deps.syncFields(page, tabFields, { dryRun: true, log });
      if (unsaved.length > 0) throw new Error(`The console did not keep the saved ${tabName(tab)} fields: ${unsaved.map((change) => change.label).join(', ')}`);
      log(`${tabName(tab)} tab: saved as a draft and read back`);
    }
    return pending;
  });
}

export async function runPublish(options, deps) {
  const { log } = deps;
  const listing = parseListing(deps.readListing());
  const pkg = deps.buildPackage();
  const problems = validateListing(listing, pkg.manifest);
  if (problems.length > 0) throw new Error(`Listing file does not match the package:\n- ${problems.join('\n- ')}`);
  log(`Package ${pkg.version} from ${pkg.commit.slice(0, 12)}: ${pkg.path}`);
  log(`  sha256 ${pkg.sha256} (${pkg.entries.length} files)`);

  if (options.inspect) {
    await withConsole(deps, async (page) => {
      for (const tab of ['', 'privacy']) {
        await deps.openConsoleTab(page, consoleUi.editUrl(listing, tab), { log });
        log(`Controls on the ${tabName(tab)} tab:`);
        for (const control of await deps.inspectControls(page)) log(`  ${control.role}: ${control.name}`);
      }
    });
    return { pkg, listing };
  }

  // API preconditions are checked before the console is touched, so a run that cannot
  // upload never leaves a half-published draft behind.
  let ids;
  if (options.upload || options.submit) {
    const token = await deps.fetchAccessToken(api.credentialsFromEnvironment(deps.env));
    ids = { token, publisherId: listing.publisherId, itemId: listing.itemId };
    const before = await deps.fetchStatus(ids);
    const live = api.publishedVersion(before);
    log(`Store serves ${live ?? 'nothing yet'}; submitted revision is ${api.submittedState(before) ?? 'none'}`);
    if (options.upload && !isNewerVersion(pkg.version, live)) {
      throw new Error(`Package version ${pkg.version} is not newer than the published ${live}; bump the manifest version first`);
    }
  }

  if (options.diff || options.listing) await syncConsole(deps, listing, options.listing);

  if (!ids) {
    if (!options.listing) log('Nothing was written. Add --listing, --upload or --submit to publish.');
    return { pkg, listing };
  }

  if (options.upload) {
    const upload = await deps.uploadPackage({ ...ids, zip: pkg.bytes });
    const parsed = await api.waitForUpload(upload, () => deps.fetchStatus(ids), { sleep: deps.sleep });
    if (parsed !== undefined && parsed !== pkg.version) throw new Error(`Store parsed version ${parsed}, expected ${pkg.version}`);
    log(`Uploaded ${pkg.version} (sha256 ${pkg.sha256})${parsed === undefined ? '; the store reports the parsed version once it is submitted' : ''}`);
  }

  let status;
  if (options.submit) {
    const result = await deps.publishItem(ids);
    for (const warning of result.warningInfo?.warnings ?? []) log(`  warning ${warning.reason}: ${warning.description}`);
    status = await deps.fetchStatus(ids);
    const submitted = api.submittedVersion(status) ?? api.publishedVersion(status);
    if (submitted !== pkg.version) throw new Error(`The store holds version ${submitted ?? 'none'} for review, expected ${pkg.version}`);
    log(`Submitted ${submitted} for review: state ${result.state}`);
  } else {
    status = await deps.fetchStatus(ids);
  }
  log(`Now: published ${api.publishedVersion(status) ?? 'nothing'}, submitted revision ${api.submittedState(status) ?? 'none'}`);
  return { pkg, listing, status };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { chromium } = await import('playwright-core');
  await runPublish(options, {
    log: (line) => console.log(line),
    env: process.env,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readListing: () => fs.readFileSync(path.join(repoRoot, 'docs', 'chrome-web-store-listing.md'), 'utf8'),
    buildPackage: () => buildPackage({ repoRoot, outDir: path.join(repoRoot, 'dist', 'store') }),
    startPublisherChrome: () => consoleUi.startPublisherChrome(),
    connectOverCDP: (endpoint) => chromium.connectOverCDP(endpoint),
    closePublisherChrome: consoleUi.closePublisherChrome,
    openConsoleTab: consoleUi.openConsoleTab,
    syncFields: consoleUi.syncFields,
    saveDraft: consoleUi.saveDraft,
    inspectControls: consoleUi.inspectControls,
    fetchAccessToken: (credentials) => api.fetchAccessToken(credentials),
    fetchStatus: (ids) => api.fetchStatus(ids),
    uploadPackage: (request) => api.uploadPackage(request),
    publishItem: (ids) => api.publishItem(ids),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
