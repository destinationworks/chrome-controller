// One-time authorization for the Chrome Web Store API: the OAuth loopback flow for a Desktop
// app client, with PKCE. Google sends the browser back to a server on 127.0.0.1 that lives only
// until the code arrives. The code, verifier and client secret are exchanged in this process,
// and the refresh token goes back to the caller, never to a log.

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

import { readJson, send } from './store-api.js';

export const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function page(response, status, message) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`<!doctype html><meta charset="utf-8"><title>Chrome Web Store API</title><p>${message}</p>`);
}

// Resolves with the authorization code from the first request to "/", or rejects when that
// request carries another run's state, an error or no code. Other paths (a favicon) get 404.
function waitForCode(server, state, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No authorization arrived within ${Math.round(timeoutMs / 1000)} seconds; nothing was stored`)), timeoutMs);
    const settle = (fn, value) => { clearTimeout(timer); fn(value); };
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') { page(response, 404, 'Not found.'); return; }
      if (url.searchParams.get('state') !== state) {
        page(response, 400, 'This answer belongs to another authorization run.');
        settle(reject, new Error('Google answered with a state that does not match this run; nothing was stored'));
      } else if (url.searchParams.get('error')) {
        page(response, 400, 'Authorization was refused.');
        settle(reject, new Error(`Authorization was refused: ${url.searchParams.get('error')}`));
      } else if (!url.searchParams.get('code')) {
        page(response, 400, 'Google sent no authorization code.');
        settle(reject, new Error('Google answered without an authorization code; nothing was stored'));
      } else {
        page(response, 200, 'Authorized. You can close this tab.');
        settle(resolve, url.searchParams.get('code'));
      }
    });
  });
}

export async function authorize({ clientId, clientSecret }, { log, fetchImpl = fetch, random = randomBytes, timeoutMs = 10 * 60_000 }) {
  const verifier = random(32).toString('base64url');
  const state = random(16).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(AUTH_URL);
    for (const [name, value] of Object.entries({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state,
    })) url.searchParams.set(name, value);
    log(`Open this URL in the browser signed in as the item owner and allow access:\n${url}`);
    const code = await waitForCode(server, state, timeoutMs);
    const response = await send('Authorization code exchange', TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }).toString(),
    }, fetchImpl);
    const body = await readJson(response, 'Authorization code exchange');
    if (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0) throw new Error('Google returned no refresh token; nothing was stored');
    if (!String(body.scope ?? '').split(' ').includes(SCOPE)) throw new Error(`Google granted access without the scope ${SCOPE}; nothing was stored`);
    return body.refresh_token;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
