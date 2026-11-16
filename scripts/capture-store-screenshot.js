import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { screenshotHtml } from './generate-store-assets.js';
import { HEALTH_CHROME_WAIT_MS, ipcClientTimeoutMs } from '../dist/chrome-wait.js';
import { IpcError, sendIpcRequest } from '../dist/ipc-client.js';
import { getSocketPath } from '../dist/native-host.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const extensionDir = path.join(repoRoot, 'Chrome Extension');
const outputPath = path.join(repoRoot, 'store-assets', 'screenshot-1280x800.jpg');
const provenancePath = path.join(repoRoot, 'store-assets', 'screenshot-capture.json');
const discoveryPath = path.join(os.homedir(), '.chrome-controller', 'default.json');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readDiscovery() {
  let discovery;
  try {
    discovery = JSON.parse(await fs.readFile(discoveryPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Chrome Controller discovery data is missing. Ensure the Native Messaging host is connected or run npm start first.');
    }
    throw error;
  }
  if (!Number.isInteger(discovery.httpPort) || typeof discovery.apiKey !== 'string') {
    throw new Error('Chrome Controller discovery data is incomplete. Run npm start first.');
  }
  return discovery;
}

async function createTransport() {
  const socketPath = getSocketPath();
  try {
    const probe = { action: 'queryTabs', timeoutMs: HEALTH_CHROME_WAIT_MS };
    const health = await sendIpcRequest(socketPath, probe, ipcClientTimeoutMs(probe.action, probe));
    if (health.success === false) {
      throw new Error(health.error || 'Chrome Controller native host reported failure');
    }
    return {
      request: async (payload) => {
        const body = await sendIpcRequest(socketPath, payload, ipcClientTimeoutMs(payload.action, payload));
        if (body.success === false) {
          throw new Error(body.error || 'Chrome Controller IPC request failed');
        }
        return body.result;
      },
    };
  } catch (error) {
    if (!(error instanceof IpcError) || error.kind !== 'unavailable') {
      throw error;
    }
  }

  const discovery = await readDiscovery();
  await assertExtensionConnected(discovery);
  return {
    request: (payload) => controllerRequest(discovery, payload),
  };
}

async function controllerRequest(discovery, payload) {
  const response = await fetch(`http://127.0.0.1:${discovery.httpPort}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': discovery.apiKey,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok || body.success === false) {
    throw new Error(body.error || `Chrome Controller request failed with HTTP ${response.status}`);
  }
  return body.result;
}

async function assertExtensionConnected(discovery) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${discovery.httpPort}/health`);
    const health = await response.json();
    if (health.extensionConnected) return;
    if (attempt < 9) await delay(500);
  }
  throw new Error('The unpacked Chrome Controller extension is not connected. Reload it in chrome://extensions and retry.');
}

async function startDemoServer(html, iconSvg) {
  const server = http.createServer((request, response) => {
    if (request.url === '/icon.svg') {
      response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
      response.end(iconSvg);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the local screenshot demo server.');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function capture() {
  const transport = await createTransport();
  const [iconSvg, contentScript, contentCss, manifestJson] = await Promise.all([
    fs.readFile(path.join(extensionDir, 'icon128.svg'), 'utf8'),
    fs.readFile(path.join(extensionDir, 'content.js'), 'utf8'),
    fs.readFile(path.join(extensionDir, 'content.css'), 'utf8'),
    fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestJson);
  const demoHtml = screenshotHtml(iconSvg);
  const { server, url } = await startDemoServer(demoHtml, iconSvg);
  let tabId;
  let initialOverlayHidden = false;
  const temporaryPath = `${outputPath}.tmp`;
  try {
    const initialOverlayState = await transport.request({ action: 'getOverlayState' });
    initialOverlayHidden = Boolean(initialOverlayState?.overlayHidden);
    if (initialOverlayHidden) {
      await transport.request({ action: 'setOverlayHidden', hidden: false });
    }
    const tab = await transport.request({ action: 'createTab', url, active: true });
    tabId = tab.id;
    await delay(700);
    await transport.request({ action: 'ensureDebugger', tabId });
    await transport.request({ action: 'setOverlayHidden', hidden: false });
    await transport.request({
      action: 'sendCommand',
      tabId,
      method: 'Emulation.setDeviceMetricsOverride',
      commandParams: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    });
    await delay(300);
    const snapshot = await transport.request({ action: 'snapshotElements', tabId, showOverlay: true });
    if (!snapshot?.success || !Number.isInteger(snapshot.count) || snapshot.count < 1) {
      throw new Error('The extension did not return a populated element snapshot.');
    }
    const click = await transport.request({ action: 'clickSelector', tabId, selector: '#generate-report' });
    if (!click?.success) throw new Error('The extension did not complete the demo-page click.');
    await transport.request({
      action: 'sendCommand',
      tabId,
      method: 'Input.dispatchMouseEvent',
      commandParams: { type: 'mouseMoved', x: 1240, y: 40 },
    });
    await delay(350);
    const overlayEvaluation = await transport.request({
      action: 'sendCommand',
      tabId,
      method: 'Runtime.evaluate',
      commandParams: {
        returnByValue: true,
        expression: `(() => {
          const root = document.querySelector('#chrome-controller-overlay-root');
          const hud = document.querySelector('.chrome-controller-hud');
          const badgeCount = document.querySelectorAll('#chrome-controller-badges-container > div').length;
          const hudRect = hud?.getBoundingClientRect();
          return { rootPresent: Boolean(root), badgeCount, hudExpanded: (hudRect?.width || 0) > 100 };
        })()`,
      },
    });
    const overlayState = overlayEvaluation?.result?.value;
    if (!overlayState?.rootPresent || overlayState.badgeCount < 1 || !overlayState.hudExpanded) {
      throw new Error(`The extension overlay was not visibly ready: ${JSON.stringify(overlayState)}`);
    }
    await transport.request({
      action: 'sendCommand',
      tabId,
      method: 'Input.dispatchMouseEvent',
      commandParams: { type: 'mouseMoved', x: 1240, y: 40 },
    });
    await delay(100);
    const screenshot = await transport.request({
      action: 'captureScreenshot',
      tabId,
      screenshotOptions: { format: 'jpeg', quality: 94, fromSurface: true, captureBeyondViewport: false },
    });
    const base64 = screenshot?.data?.data;
    if (typeof base64 !== 'string' || base64.length < 1_000) {
      throw new Error('Chrome returned an invalid screenshot payload.');
    }
    const image = Buffer.from(base64, 'base64');
    await fs.writeFile(temporaryPath, image);
    await fs.rename(temporaryPath, outputPath);
    await fs.writeFile(provenancePath, `${JSON.stringify({
      source: 'live-extension',
      manifestName: manifest.name,
      capturedManifestVersion: manifest.version,
      demoHtmlSha256: createHash('sha256').update(demoHtml).digest('hex'),
      contentScriptSha256: createHash('sha256').update(contentScript).digest('hex'),
      contentCssSha256: createHash('sha256').update(contentCss).digest('hex'),
      width: 1280,
      height: 800,
      snapshotElementCount: snapshot.count,
      overlayBadgeCount: overlayState.badgeCount,
      hudExpanded: true,
      sha256: createHash('sha256').update(image).digest('hex'),
    }, null, 2)}\n`);
  } finally {
    await fs.rm(temporaryPath, { force: true });
    if (tabId) {
      try {
        await transport.request({ action: 'removeTab', tabId });
      } catch (error) {
        console.warn(`Could not close temporary screenshot tab ${tabId}: ${error.message}`);
      }
    }
    if (initialOverlayHidden) {
      try {
        await transport.request({ action: 'setOverlayHidden', hidden: true });
      } catch {
        // Best-effort restore
      }
    }
    await closeServer(server);
  }
  console.log(`Captured real Chrome Controller HUD screenshot at ${outputPath}`);
}

await capture();
