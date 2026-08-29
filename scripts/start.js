#!/usr/bin/env node
/**
 * Automated Chrome Controller server startup.
 *
 * Kills stale server, rebuilds if needed, starts fresh, and waits for healthy.
 * Usage: node scripts/start.js [--no-rebuild]
 */
import { spawn, execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const DEFAULT_HTTP_PORT = 8898;
const DEFAULT_WS_PORT = 8899;
const API_KEY = process.env.API_KEY ?? 'B3C65095-74E1-4F48-9EBB-64F5DD6AB078';
const HTTP_PORT = process.env.HTTP_PORT ?? DEFAULT_HTTP_PORT;
const WS_PORT = process.env.WS_PORT ?? DEFAULT_WS_PORT;

const noRebuild = process.argv.includes('--no-rebuild');

// ── Helpers ──────────────────────────────────────────────────────────────────

function info(msg) {
  console.log(`[chrome-controller] ${msg}`);
}

function httpGet(url) {
  try {
    return execSync(`curl -s --max-time 2 "${url}" 2>/dev/null`, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function killPort(port) {
  try {
    const pid = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (pid) {
      execSync(`kill ${pid} 2>/dev/null`);
      info(`Killed process on port ${port}`);
    }
  } catch {
    // nothing running
  }
}

function needsRebuild() {
  // Check all TypeScript sources against compiled outputs
  const pairs = [
    ['src/server.ts', 'dist/server.js'],
    ['src/index.ts', 'dist/index.js'],
    ['src/mcp.ts', 'dist/mcp.js'],
  ];
  for (const [srcRel, distRel] of pairs) {
    const srcPath = join(ROOT, srcRel);
    const distPath = join(ROOT, distRel);
    try {
      const srcMtime = statSync(srcPath).mtimeMs;
      const distMtime = statSync(distPath).mtimeMs;
      if (srcMtime > distMtime) return true;
    } catch {
      return true; // file missing
    }
  }
  return false;
}

function build() {
  info('Building...');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const serverRunning = httpGet(`http://127.0.0.1:${HTTP_PORT}/health`) !== null;
  const rebuildNeeded = !noRebuild && needsRebuild();

  if (serverRunning && !rebuildNeeded) {
    info('Server already running, build current. OK.');
    return;
  }

  // 2. Kill existing server
  if (serverRunning) {
    info('Stopping existing server...');
    killPort(HTTP_PORT);
    killPort(WS_PORT);
    await new Promise(r => setTimeout(r, 1000));
  }

  // 3. Rebuild if needed
  if (rebuildNeeded) {
    build();
  } else {
    info('Build up-to-date, skipping.');
  }

  // 4. Start server
  info(`Starting server on port ${HTTP_PORT}...`);
  const server = spawn('node', [join(ROOT, 'dist/server.js')], {
    cwd: ROOT,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, HTTP_PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT), API_KEY },
    detached: false,
  });

  server.on('exit', (code, signal) => {
    if (code !== 0) {
      console.error(`[chrome-controller] Server exited with code ${code} signal ${signal}`);
      process.exit(code ?? 1);
    }
  });

  // 5. Wait for healthy
  info('Waiting for server to become healthy...');
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    const h = httpGet(`http://127.0.0.1:${HTTP_PORT}/health`);
    if (h) {
      info('Server is healthy!');
      info(`  HTTP: http://127.0.0.1:${HTTP_PORT}`);
      info(`  WS:   ws://127.0.0.1:${WS_PORT}`);
      info(`  Key:  ${API_KEY}`);
      info('Load the Chrome extension in chrome://extensions to connect.');
      // Keep process alive — server runs in foreground
      return;
    }
  }
  console.error('[chrome-controller] Server did not become healthy in time.');
  process.exit(1);
}

main().catch(err => {
  console.error('[chrome-controller] Startup failed:', err);
  process.exit(1);
});
