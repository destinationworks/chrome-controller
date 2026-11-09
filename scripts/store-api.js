// Chrome Web Store API V2: package upload, submission status and publish. The API cannot edit
// listing text; scripts/store-console.js fills those fields in the Developer Console.
// Credentials come from the caller (environment, normally via `op run`) and never appear in
// errors or logs.

const API_ORIGIN = 'https://chromewebstore.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CREDENTIAL_VARIABLES = ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN'];

export function credentialsFromEnvironment(env) {
  const missing = CREDENTIAL_VARIABLES.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Chrome Web Store API credentials are missing: ${missing.join(', ')}. Run through \`op run --env-file=.env.store\` (see docs/store-publishing.md).`);
  }
  return { clientId: env.CWS_CLIENT_ID, clientSecret: env.CWS_CLIENT_SECRET, refreshToken: env.CWS_REFRESH_TOKEN };
}

function itemPath(publisherId, itemId) {
  return `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
}

// Google's error body says what was wrong; the request (and its token) is never echoed.
async function readJson(response, what) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = undefined; }
  if (!response.ok) {
    const detail = body?.error_description ?? body?.error?.message ?? (typeof body?.error === 'string' ? body.error : '');
    throw new Error(`${what} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  if (body === undefined || typeof body !== 'object' || Array.isArray(body)) throw new Error(`${what} returned a response that is not a JSON object`);
  return body;
}

export async function fetchAccessToken({ clientId, clientSecret, refreshToken }, fetchImpl = fetch) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
  });
  const body = await readJson(response, 'Access token refresh');
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error('Access token refresh returned no access_token');
  }
  return body.access_token;
}

export async function uploadPackage({ token, publisherId, itemId, zip }, fetchImpl = fetch) {
  const response = await fetchImpl(`${API_ORIGIN}/upload/v2/${itemPath(publisherId, itemId)}:upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
    body: zip,
  });
  return readJson(response, 'Package upload');
}

export async function fetchStatus({ token, publisherId, itemId }, fetchImpl = fetch) {
  const response = await fetchImpl(`${API_ORIGIN}/v2/${itemPath(publisherId, itemId)}:fetchStatus`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  const status = await readJson(response, 'Status fetch');
  // An empty answer would read as "nothing published" and wave any version through.
  if (status.itemId !== itemId) throw new Error(`Status fetch answered for item ${status.itemId ?? 'none'}, expected ${itemId}`);
  return status;
}

// States a successful submission can report; anything else (REJECTED, CANCELLED, unknown)
// fails the run.
export const SUBMITTED_STATES = new Set(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);

// Submits the item for review. blockOnWarnings makes Google refuse instead of publishing
// past a validation warning nobody has read.
export async function publishItem({ token, publisherId, itemId }, fetchImpl = fetch) {
  const response = await fetchImpl(`${API_ORIGIN}/v2/${itemPath(publisherId, itemId)}:publish`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true }),
  });
  const result = await readJson(response, 'Publish');
  if (!SUBMITTED_STATES.has(result.state)) throw new Error(`Publish ended in state ${result.state ?? 'unknown'}`);
  return result;
}

// An upload Google is still processing reports IN_PROGRESS (the reference also spells it
// UPLOAD_IN_PROGRESS); its outcome arrives later as lastAsyncUploadState. Resolves with the
// version Google parsed when the upload answer carried one, otherwise undefined: status
// responses describe published and submitted revisions, never a fresh draft.
export async function waitForUpload(upload, poll, { sleep, attempts = 30, intervalMs = 2_000 }) {
  let state = upload.uploadState;
  for (let attempt = 0; state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS'; attempt += 1) {
    if (attempt >= attempts) throw new Error(`Package upload still processing after ${attempts} status checks`);
    await sleep(intervalMs);
    state = (await poll()).lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') throw new Error(`Package upload ended in state ${state ?? 'unknown'}`);
  return upload.crxVersion;
}

export function submittedVersion(status) {
  return status.submittedItemRevisionStatus?.distributionChannels?.[0]?.crxVersion;
}

// The version the store currently serves, or undefined when nothing is published.
export function publishedVersion(status) {
  return status.publishedItemRevisionStatus?.distributionChannels?.[0]?.crxVersion;
}

export function submittedState(status) {
  return status.submittedItemRevisionStatus?.state;
}
