// Where the Chrome Web Store API credentials come from. CWS_* environment variables win (CI,
// or `op run`); otherwise they are read from the macOS login Keychain, where --authorize
// stores the refresh token. Values travel only through the `security` tool's stdin and
// stdout: never argv, files or logs.

import { spawnSync } from 'node:child_process';

import { CREDENTIAL_VARIABLES, credentialsFromEnvironment } from './store-api.js';

export const KEYCHAIN_SERVICE = 'chrome-controller-store-api';
export const KEYCHAIN_ACCOUNTS = { clientId: 'client_id', clientSecret: 'client_secret', refreshToken: 'refresh_token' };
const NOT_FOUND = 44; // `security find-generic-password` exit status for a missing item
// `security -i` splits its command on whitespace and treats quotes and backslashes specially,
// and a leading "-" would read as an option, so only token characters are written.
const KEYCHAIN_VALUE = /^[A-Za-z0-9._~/+=][A-Za-z0-9._~/+=-]*$/;

function failure(action, account, result) {
  if (result.error?.code === 'ENOENT') return new Error(`${action} ${account} needs the macOS \`security\` tool; elsewhere set ${CREDENTIAL_VARIABLES.join(', ')}`);
  return new Error(`${action} ${account} in the Keychain failed (security exit ${result.status ?? result.error?.code ?? 'unknown'})`);
}

// `file` names a keychain other than the login keychain's search list; tests pass a temporary one.
export function keychain({ run = spawnSync, service = KEYCHAIN_SERVICE, file } = {}) {
  if (file !== undefined && !/^\/[\w./-]+$/.test(file)) throw new Error(`Keychain file "${file}" must be an absolute path without spaces`);
  const where = file === undefined ? [] : [file];
  const read = (account) => {
    const result = run('security', ['find-generic-password', '-s', service, '-a', account, '-w', ...where], { encoding: 'utf8' });
    if (result.status === NOT_FOUND) return undefined;
    if (result.status !== 0) throw failure('Reading', account, result);
    return result.stdout.replace(/\n$/, '');
  };
  const write = (account, value) => {
    if (!KEYCHAIN_VALUE.test(value)) throw new Error(`${account} has characters the Keychain command cannot carry; nothing was stored`);
    const result = run('security', ['-i'], { input: `add-generic-password -U -s ${service} -a ${account} -w ${[value, ...where].join(' ')}\n`, encoding: 'utf8' });
    if (result.status !== 0) throw failure('Writing', account, result);
    // `security -i` can report success for a command it rejected; the read-back decides.
    if (read(account) !== value) throw new Error(`The Keychain did not keep ${account}`);
  };
  return { read, write };
}

function readAccounts(store, names) {
  const values = Object.fromEntries(names.map((name) => [name, store.read(KEYCHAIN_ACCOUNTS[name])]));
  const missing = names.filter((name) => !values[name]).map((name) => KEYCHAIN_ACCOUNTS[name]);
  return { values, missing };
}

// Credentials for upload and submit: all three variables, or all three Keychain entries.
export function apiCredentials(env, store) {
  if (CREDENTIAL_VARIABLES.some((name) => env[name])) return credentialsFromEnvironment(env);
  const { values, missing } = readAccounts(store, ['clientId', 'clientSecret', 'refreshToken']);
  if (missing.length > 0) {
    const fix = missing.includes(KEYCHAIN_ACCOUNTS.clientId) || missing.includes(KEYCHAIN_ACCOUNTS.clientSecret)
      ? 'store the OAuth client first, then run `npm run store:publish -- --authorize`'
      : 'run `npm run store:publish -- --authorize`';
    throw new Error(`Chrome Web Store API credentials are missing from the Keychain service "${KEYCHAIN_SERVICE}": ${missing.join(', ')}. Either ${fix} (see docs/store-publishing.md), or set ${CREDENTIAL_VARIABLES.join(', ')}.`);
  }
  return values;
}

// The OAuth client for --authorize, which stores its refresh token in the Keychain. A CWS_*
// variable would override that token on every later run, so it is refused here.
export function clientCredentials(env, store) {
  const set = CREDENTIAL_VARIABLES.filter((name) => env[name]);
  if (set.length > 0) throw new Error(`--authorize stores the refresh token in the Keychain, but ${set.join(', ')} would override it on later runs; unset them first`);
  const { values, missing } = readAccounts(store, ['clientId', 'clientSecret']);
  if (missing.length > 0) throw new Error(`The OAuth client is missing from the Keychain service "${KEYCHAIN_SERVICE}": ${missing.join(', ')}. Store it as docs/store-publishing.md describes.`);
  return values;
}
