/**
 * Port mismatch detection tests.
 *
 * Verifies that when the server binds to dynamic ports (port 0),
 * the actual bound ports are reported correctly via health endpoint,
 * and the discovery file contains the real ports (not hardcoded defaults).
 */

import { createChromeControllerServer } from '../src/server.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, after, describe, it } from 'node:test';
import http from 'node:http';
import { WebSocket } from 'ws';

function httpGet(host: string, port: number, pathStr = '/') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host, port, path: pathStr, timeout: 5000 }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTP request to ${host}:${port}${pathStr} timed out`));
    });
    req.end();
  });
}

function connectWebSocket(host: string, port: number, token: string) {
  const url = `ws://${host}:${port}`;
  const headers = { 'Authorization': `Bearer ${token}` };

  const ws = new WebSocket(url, { headers });

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Connection to ${url} timed out`));
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe('Port mismatch detection', () => {
  let server: Awaited<ReturnType<typeof createChromeControllerServer>>;
  const instance = 'port-mismatch-test';
  const discoveryDir = path.join(os.homedir(), '.chrome-controller');
  const discoveryPath = path.join(discoveryDir, `${instance}.json`);

  before(async () => {
    // Clean up any stale discovery file from previous runs
    try { await fs.unlink(discoveryPath); } catch { /* ignore */ }

    server = createChromeControllerServer({
      httpPort: 0,         // random available port
      wsPort: 0,           // random available port
      apiKey: 'test-token-0123456789abcdef012345',
      instance,
    });
    await server.ready;
  });

  after(async () => {
    await server.close();
  });

  it('server binds to dynamic ports (not hardcoded)', () => {
    assert.notEqual(server.httpPort, 8898, 'HTTP port should not be the hardcoded 8898');
    assert.notEqual(server.wsPort, 8899, 'WS port should not be the hardcoded 8899');
    assert.ok(server.httpPort > 0, 'HTTP port should be assigned');
    assert.ok(server.wsPort > 0, 'WS port should be assigned');
  });

  it('HTTP endpoint works on actual dynamic port', async () => {
    const resp = await httpGet('127.0.0.1', server.httpPort, '/health');
    assert.equal(resp.status, 200);
    const health = JSON.parse(resp.body);
    assert.equal(health.success, true);
  });

  it('WebSocket works on actual dynamic port', async () => {
    await connectWebSocket('127.0.0.1', server.wsPort, 'test-token-0123456789abcdef012345');
  });

  it('discovery file contains actual dynamic ports, not hardcoded defaults', async () => {
    const raw = await fs.readFile(discoveryPath, 'utf8');
    const discovery = JSON.parse(raw);

    assert.equal(discovery.httpPort, server.httpPort, 'discovery file httpPort matches actual bound port');
    assert.equal(discovery.wsPort, server.wsPort, 'discovery file wsPort matches actual bound port');
    assert.notEqual(discovery.httpPort, 8898, 'discovery file should NOT contain hardcoded port 8898');
    assert.notEqual(discovery.wsPort, 8899, 'discovery file should NOT contain hardcoded port 8899');
  });

  it('health endpoint reports correct dynamic ports', async () => {
    const resp = await httpGet('127.0.0.1', server.httpPort, '/health');
    const health = JSON.parse(resp.body);
    assert.equal(health.httpPort, server.httpPort);
    assert.equal(health.wsPort, server.wsPort);
  });
});
