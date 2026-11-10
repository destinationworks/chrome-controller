// Fills the Developer Console's listing text fields from the listing file. Chrome refuses
// to let extensions script Web Store pages (the console included), so Chrome Controller
// cannot reach them; instead this drives a dedicated Chrome profile over the DevTools
// protocol. The profile keeps its Google sign-in between runs; when Google asks to verify
// the account, the run waits for the user to do it in that window.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROFILE_DIR = path.join(os.homedir(), '.chrome-controller', 'store-publisher-profile');
export const CHROME_BINARY = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIGN_IN_HOST = 'accounts.google.com';

export function editUrl(listing, tab = '') {
  return `https://chrome.google.com/webstore/devconsole/${listing.publisherId}/${listing.itemId}/edit${tab ? `/${tab}` : ''}`;
}

// Every console field the listing file owns, in the order a person would fill them.
// `label` is the field's visible label; see `labelPattern` for how it is matched. A label
// that does not match exactly one control stops the run before anything is written.
export function consoleFieldPlan(listing) {
  return [
    { tab: '', label: 'Description', kind: 'text', value: listing.description },
    { tab: '', label: 'Category', kind: 'select', value: listing.category },
    { tab: '', label: 'Language', kind: 'select', value: listing.language },
    { tab: '', label: 'Homepage URL', kind: 'text', value: listing.homepageUrl },
    { tab: '', label: 'Support URL', kind: 'text', value: listing.supportUrl },
    { tab: 'privacy', label: 'Single purpose description', kind: 'text', value: listing.singlePurpose },
    ...listing.permissionJustifications.map(([name, text]) => ({
      tab: 'privacy',
      label: name === 'Host permission' ? 'Host permission justification' : `${name} justification`,
      kind: 'text',
      value: text,
    })),
    { tab: 'privacy', label: 'Privacy policy URL', kind: 'text', value: listing.privacyPolicyUrl },
  ];
}

// Whether a Chrome process holds this profile, from the lock Chrome links to its pid.
export function profileInUse(profileDir) {
  try {
    const pid = Number(fs.readlinkSync(path.join(profileDir, 'SingletonLock')).split('-').pop());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Google refuses to sign in inside a browser driven over DevTools, so sign-in happens in
// this profile opened as plain Chrome; automated runs then reuse the saved session.
export function openSignInChrome(url, { profileDir = PROFILE_DIR, chromeBinary = CHROME_BINARY, spawnImpl = spawn, isProfileInUse = profileInUse } = {}) {
  if (isProfileInUse(profileDir)) throw new Error('The publisher profile is already open; sign in in that window, or quit it (Cmd+Q) and run --sign-in again');
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  spawnImpl(chromeBinary, [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', url], { detached: true, stdio: 'ignore' }).unref?.();
}

// Port of a Chrome already serving this profile, from the file Chrome writes on startup.
function activePort(profileDir) {
  try {
    const [port] = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n');
    return Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : undefined;
  } catch {
    return undefined;
  }
}

async function answers(port, fetchImpl) {
  try {
    return (await fetchImpl(`http://127.0.0.1:${port}/json/version`)).ok;
  } catch {
    return false;
  }
}

// Reuses the publisher Chrome if it is running, otherwise starts it with a DevTools port on
// loopback for this profile only; the user's everyday profile is untouched. Any local process
// can use that port while it is open, so callers close this Chrome when the run ends.
export async function startPublisherChrome({
  profileDir = PROFILE_DIR, chromeBinary = CHROME_BINARY, spawnImpl = spawn, fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), startupChecks = 60, isProfileInUse = profileInUse,
} = {}) {
  const running = activePort(profileDir);
  if (running && await answers(running, fetchImpl)) return { port: running, started: false };
  // A second launch would only hand its window to the Chrome already holding the profile.
  if (isProfileInUse(profileDir)) throw new Error('The publisher profile is open in a Chrome without automation (from --sign-in); quit that Chrome (Cmd+Q), then run again');
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true });
  const child = spawnImpl(chromeBinary, [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
  ], { detached: true, stdio: 'ignore' });
  child.unref?.();
  for (let check = 0; check < startupChecks; check += 1) {
    const port = activePort(profileDir);
    if (port && await answers(port, fetchImpl)) return { port, started: true };
    await sleep(500);
  }
  throw new Error(`Publisher Chrome did not open its DevTools port; is ${chromeBinary} installed?`);
}

// Opens a console tab and waits while Google shows its sign-in or "Verify it's you" page.
export async function openConsoleTab(page, url, { log, timeoutMs = 10 * 60_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  let asked = false;
  for (const deadline = Date.now() + timeoutMs; new URL(page.url()).host === SIGN_IN_HOST;) {
    if (new URL(page.url()).pathname.includes('/signin/rejected')) {
      throw new Error('Google refused to sign in inside the automated publisher Chrome. Run `npm run store:publish -- --sign-in`, sign in there, quit that Chrome (Cmd+Q), then run again');
    }
    if (!asked) {
      log('Google wants you to sign in or verify the account in the publisher Chrome window. Waiting...');
      asked = true;
    }
    if (page.isClosed()) throw new Error('The publisher Chrome window was closed before Google sign-in finished');
    if (Date.now() > deadline) throw new Error('Timed out waiting for Google sign-in in the publisher Chrome window');
    await sleep(2_000);
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  const opened = new URL(page.url());
  if (`${opened.origin}${opened.pathname.replace(/\/$/, '')}` !== url) throw new Error(`Console opened ${page.url()} instead of ${url}`);
}

// Closes the publisher Chrome itself, which shuts its DevTools port; disconnecting would
// leave Chrome running with the signed-in profile reachable on that port.
export async function closePublisherChrome(browser) {
  const session = await browser.newBrowserCDPSession();
  await session.send('Browser.close').catch(() => {});
}

// The console's accessible names add "*" to required fields, and a combobox's name ends with
// its current value ("Category* Developer Tools"), so match the label, the optional "*" and,
// for a combobox, anything after a space.
function escapeLabel(label) {
  return label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function labelPattern(field) {
  const label = escapeLabel(field.label);
  return new RegExp(field.kind === 'select' ? `^${label}\\*?(?: |$)` : `^${label}\\*?$`);
}

async function controlFor(page, field) {
  const role = field.kind === 'select' ? 'combobox' : 'textbox';
  const locator = page.getByRole(role, { name: labelPattern(field) });
  const count = await locator.count();
  if (count !== 1) throw new Error(`Console field "${field.label}" matched ${count} controls; the console layout changed, so nothing was saved`);
  return locator;
}

// A native <select> reports every option as its text, so read the selected one. The console's
// own comboboxes put their label in innerText too ("Category\nDeveloper Tools"), so their value
// is read from the accessible name instead, after the label and its "*".
async function readControl(locator, field) {
  if (field.kind !== 'select') return locator.inputValue();
  const native = await locator.evaluate((node) => (node.tagName === 'SELECT' ? (node.selectedOptions[0]?.textContent ?? '').trim() : null));
  if (native !== null) return native;
  const name = /"((?:[^"\\]|\\.)*)"/.exec(await locator.ariaSnapshot())?.[1]?.replace(/\\(.)/g, '$1') ?? '';
  return name.replace(new RegExp(`^${escapeLabel(field.label)}\\*? ?`), '').trim();
}

// Locates every field before touching any, so a changed layout writes nothing; then, unless
// dryRun, writes the fields that differ and reads each back. A read-back mismatch throws
// before the caller can save.
export async function syncFields(page, fields, { dryRun, log }) {
  const located = [];
  for (const field of fields) {
    const control = await controlFor(page, field);
    located.push({ field, control, current: await readControl(control, field) });
  }
  const changes = [];
  for (const { field, control, current } of located) {
    if (current === field.value) continue;
    changes.push({ label: field.label, from: current, to: field.value });
    if (dryRun) continue;
    if (field.kind === 'select') {
      await control.click();
      const option = page.getByRole('option', { name: field.value, exact: true });
      if (await option.count() !== 1) throw new Error(`Console field "${field.label}" has no single option "${field.value}"; nothing was saved`);
      await option.click();
    } else {
      await control.fill(field.value);
    }
    const written = await readControl(control, field);
    if (written !== field.value) throw new Error(`Console field "${field.label}" did not keep the new value; nothing was saved`);
    log(`  updated ${field.label}`);
  }
  return changes;
}

export async function saveDraft(page) {
  const button = page.getByRole('button', { name: 'Save draft', exact: true });
  if (await button.count() !== 1) throw new Error('Console has no single "Save draft" button; nothing was saved');
  await button.click();
  await page.waitForLoadState('networkidle').catch(() => {});
}

// Every form control on the current console page with the accessible name the field map
// matches against, read from the page's ARIA snapshot.
export async function inspectControls(page) {
  const snapshot = await page.locator('body').ariaSnapshot();
  const controls = [];
  for (const match of snapshot.matchAll(/- (textbox|combobox|checkbox|radio|button) "((?:[^"\\]|\\.)*)"/g)) {
    controls.push({ role: match[1], name: match[2].replace(/\\(.)/g, '$1') });
  }
  return controls;
}
