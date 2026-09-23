/**
 * Unit tests for the native host watchdog (src/watchdog.ts).
 *
 * Run: npx tsx --test src/watchdog.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { NativeMessagingHost, pidFilePathForSocket, readHostPid } from './native-host.js';
import {
  probeHost,
  recoverHost,
  processAlive,
  identifyHostProcess,
  removeHostPidFile,
  exitCodeForState,
  formatReport,
  runCli,
} from './watchdog.js';

function tmpSocket(prefix: string): { dir: string; socket: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, socket: path.join(dir, 'run.sock') };
}

/**
 * Spawns a fixture process from a file named `native-host.js`, so the real
 * `identifyHostProcess` (which inspects the process command line) accepts it.
 * `swallowSigterm` reproduces the production wedge: a JS SIGTERM handler
 * replaces the default terminate action, so the signal is ignored.
 */
async function spawnHostFixture(
  dir: string,
  { swallowSigterm }: { swallowSigterm: boolean },
): Promise<ChildProcess> {
  const script = path.join(dir, 'native-host.js');
  fs.writeFileSync(
    script,
    `${swallowSigterm ? "process.on('SIGTERM', () => {});" : ''}\nconsole.log('up');\nsetInterval(() => {}, 1000);\n`,
  );
  const child = spawn(process.execPath, [script]);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('up')) resolve(); });
    child.once('error', reject);
  });
  return child;
}

test('probeHost reports down when no socket exists', async () => {
  const { dir, socket } = tmpSocket('wd-down-');
  try {
    const result = await probeHost(socket, 500);
    assert.strictEqual(result.state, 'down');
    assert.strictEqual(result.pid, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeHost reports alive for a host with no Chrome peer attached', async () => {
  // Regression: every IPC action used to be forwarded to Chrome, so a liveness
  // probe against a host with a dead browser side timed out instead of
  // answering. hostPing must be served locally.
  const { dir, socket } = tmpSocket('wd-alive-');
  const host = new NativeMessagingHost(socket);
  await host.ready;
  try {
    const result = await probeHost(socket, 2000);
    assert.strictEqual(result.state, 'alive');
    assert.strictEqual(result.pid, process.pid);
    assert.strictEqual(result.liveness?.pong, true);
    assert.strictEqual(result.liveness?.pendingRequests, 0);
    const uptimeMs = result.liveness?.uptimeMs as number;
    assert.ok(Number.isFinite(uptimeMs) && uptimeMs >= 0 && uptimeMs < 60_000, `implausible uptime ${uptimeMs}`);
  } finally {
    host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeHost reports wedged when the socket accepts but never answers', async () => {
  // Reproduces the observed failure: listener bound, connections accepted,
  // no response because the event loop is not servicing requests.
  const { dir, socket } = tmpSocket('wd-wedged-');
  const server = net.createServer(() => { /* accept and ignore, like a wedged loop */ });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const result = await probeHost(socket, 300);
    assert.strictEqual(result.state, 'wedged');
    assert.match(result.detail, /event loop is not turning/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeHost reports stale-socket for a socket file left by a killed host', async () => {
  const { dir, socket } = tmpSocket('wd-stale-');
  // A SIGKILLed process cannot unlink its socket, so bind in a child and kill it.
  const child = spawn(process.execPath, [
    '-e',
    `require('net').createServer(()=>{}).listen(${JSON.stringify(socket)}, () => console.log('up'))`,
  ]);
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d) => { if (d.toString().includes('up')) resolve(); });
      child.on('error', reject);
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
    assert.ok(fs.existsSync(socket), 'SIGKILL must leave the socket file behind');

    const result = await probeHost(socket, 1000);
    assert.strictEqual(result.state, 'stale-socket');
    assert.match(result.detail, /nothing is listening/);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverHost escalates to SIGKILL when SIGTERM is swallowed', async () => {
  const { dir } = tmpSocket('wd-kill-');
  const child = await spawnHostFixture(dir, { swallowSigterm: true });
  try {
    const pid = child.pid!;
    assert.ok(processAlive(pid));

    const result = await recoverHost(pid, { sigtermGraceMs: 400 });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.escalatedToSigkill, true, 'SIGTERM alone must not be trusted');
    assert.strictEqual(result.killed, true);
    assert.match(result.detail, /swallowed SIGTERM/);
  } finally {
    if (child.pid && processAlive(child.pid)) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverHost stops at SIGTERM for a host that shuts down cleanly', async () => {
  const { dir } = tmpSocket('wd-clean-');
  const child = await spawnHostFixture(dir, { swallowSigterm: false });
  try {
    const result = await recoverHost(child.pid!, { sigtermGraceMs: 600 });
    assert.strictEqual(result.killed, true);
    assert.strictEqual(result.escalatedToSigkill, false, 'a responsive host must not be SIGKILLed');
  } finally {
    if (child.pid && processAlive(child.pid)) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverHost does not signal a PID that is already gone', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid!;
  await new Promise((r) => child.on('exit', r));
  const result = await recoverHost(pid, { sigtermGraceMs: 10 });
  assert.strictEqual(result.attempted, false);
  assert.strictEqual(result.killed, false);
});

test('host writes a private PID file and removes it on close', async () => {
  const { dir, socket } = tmpSocket('wd-pid-');
  const host = new NativeMessagingHost(socket);
  await host.ready;
  const pidPath = pidFilePathForSocket(socket);
  try {
    assert.strictEqual(readHostPid(socket), process.pid);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(pidPath).mode & 0o777, 0o600);
    }
  } finally {
    host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.strictEqual(fs.existsSync(pidPath), false, 'clean shutdown must not leave a PID file');
});

test('readHostPid rejects a corrupt PID file instead of returning a bogus PID', () => {
  const { dir, socket } = tmpSocket('wd-badpid-');
  try {
    fs.writeFileSync(pidFilePathForSocket(socket), 'not-a-pid\n');
    assert.strictEqual(readHostPid(socket), null);
    fs.writeFileSync(pidFilePathForSocket(socket), '-5\n');
    assert.strictEqual(readHostPid(socket), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exitCodeForState fails for every non-alive state', () => {
  assert.strictEqual(exitCodeForState('alive'), 0);
  for (const state of ['wedged', 'stale-socket', 'down'] as const) {
    assert.strictEqual(exitCodeForState(state), 1, `${state} must be a failure exit`);
  }
});

test('formatReport surfaces the recovery hint only for an unrecovered wedge', () => {
  const wedged = { state: 'wedged' as const, socketPath: '/s', pid: 42, detail: 'stuck' };
  assert.match(formatReport(wedged), /--recover/);
  assert.doesNotMatch(
    formatReport(wedged, { attempted: true, killed: true, escalatedToSigkill: true, detail: 'done' }),
    /--recover/,
  );
  assert.doesNotMatch(formatReport({ state: 'down', socketPath: '/s', pid: null, detail: 'no socket' }), /--recover/);
});

test('formatReport renders the operator-facing liveness lines', () => {
  const rendered = formatReport({
    state: 'alive',
    socketPath: '/s',
    pid: 7,
    detail: 'ok',
    liveness: { pong: true, uptimeMs: 90_000, chromeConnected: true, lastChromeMessageAt: null, pendingRequests: 3 },
  });
  assert.match(rendered, /uptime: 90s/);
  assert.match(rendered, /chrome: connected=true lastMessageAt=never pending=3/);
});

test('runCli rejects an out-of-range timeout', async () => {
  assert.strictEqual(await runCli(['--timeout', '0']), 2);
  assert.strictEqual(await runCli(['--timeout', 'abc']), 2);
  assert.strictEqual(await runCli(['--timeout', '999999']), 2);
});

test('probeHost treats an error response as alive, not wedged', async () => {
  // A host predating hostPing answers "Unknown action". It is answering, so its
  // event loop is turning -- calling that wedged would send an operator to
  // SIGKILL a perfectly healthy host.
  const { dir, socket } = tmpSocket('wd-legacy-');
  const server = net.createServer((c) => {
    c.on('data', () => c.write(JSON.stringify({ id: 1, success: false, error: 'Error: Unknown action: hostPing' }) + '\n'));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const result = await probeHost(socket, 1000);
    assert.strictEqual(result.state, 'alive');
    assert.match(result.detail, /predates the hostPing/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeHost reports a responsive host that rejects hostPing for another reason', async () => {
  const { dir, socket } = tmpSocket('wd-refuse-');
  const server = net.createServer((c) => {
    c.on('data', () => c.write(JSON.stringify({ id: 1, success: false, error: 'locked during guarded extraction' }) + '\n'));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const result = await probeHost(socket, 1000);
    assert.strictEqual(result.state, 'alive');
    assert.match(result.detail, /responsive but rejected/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeHost still reports wedged for an unparseable response', async () => {
  const { dir, socket } = tmpSocket('wd-garbage-');
  const server = net.createServer((c) => {
    c.on('data', () => c.write('not json at all\n'));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const result = await probeHost(socket, 1000);
    assert.strictEqual(result.state, 'wedged');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverHost refuses to signal a live process that is not a native host', async () => {
  // PID files survive SIGKILL and the OS reuses PIDs, so --recover must not
  // take the file's word for it and kill an unrelated process.
  const { dir } = tmpSocket('wd-wrongpid-');
  const script = path.join(dir, 'definitely-not-the-host.js');
  fs.writeFileSync(script, "console.log('up');\nsetInterval(() => {}, 1000);\n");
  const bystander = spawn(process.execPath, [script]);
  try {
    await new Promise<void>((resolve, reject) => {
      bystander.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('up')) resolve(); });
      bystander.once('error', reject);
    });
    const pid = bystander.pid!;

    const result = await recoverHost(pid, { sigtermGraceMs: 200 });

    assert.strictEqual(result.attempted, false);
    assert.strictEqual(result.killed, false);
    assert.match(result.detail, /Refusing to signal/);
    assert.ok(processAlive(pid), 'an unrelated process must survive --recover');
  } finally {
    if (bystander.pid && processAlive(bystander.pid)) bystander.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverHost does not escalate when the PID stops being the host mid-recovery', async () => {
  // The host may exit during the SIGTERM grace window and the PID be reused.
  // SIGKILL is unblockable, so identity must be re-confirmed before it is sent.
  const { dir } = tmpSocket('wd-reuse-');
  const child = await spawnHostFixture(dir, { swallowSigterm: true });
  try {
    let calls = 0;
    const result = await recoverHost(child.pid!, {
      sigtermGraceMs: 100,
      identify: () => { calls += 1; return { isHost: calls === 1, command: 'something-else' }; },
    });
    assert.strictEqual(calls, 2, 'identity must be re-checked before SIGKILL');
    assert.strictEqual(result.escalatedToSigkill, false);
    assert.strictEqual(result.killed, false);
    assert.match(result.detail, /no longer a native host/);
    assert.ok(processAlive(child.pid!), 'the process must not be SIGKILLed after failing re-identification');
  } finally {
    if (child.pid && processAlive(child.pid)) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverHost sends no signal at all when the PID is already gone', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid!;
  await new Promise((r) => child.on('exit', r));

  const signalled: Array<number | string> = [];
  const originalKill = process.kill.bind(process);
  (process as unknown as { kill: unknown }).kill = (target: number, signal?: number | string) => {
    if (target === pid && signal !== 0) signalled.push(signal ?? 'default');
    return originalKill(target, signal as never);
  };
  try {
    const result = await recoverHost(pid, { sigtermGraceMs: 10 });
    assert.strictEqual(result.attempted, false);
    assert.deepStrictEqual(signalled, [], 'a dead PID must never be signalled');
  } finally {
    (process as unknown as { kill: unknown }).kill = originalKill;
  }
});

test('identifyHostProcess recognises the host and rejects other processes', async () => {
  const { dir } = tmpSocket('wd-identify-');
  const child = await spawnHostFixture(dir, { swallowSigterm: false });
  try {
    const identified = identifyHostProcess(child.pid!);
    assert.strictEqual(identified.isHost, true);
    assert.match(String(identified.command), /native-host\.js/);

    // This test process is node, but not a native host.
    assert.strictEqual(identifyHostProcess(process.pid).isHost, false);
    // PID 1 exists but is not ours; it must never be classified as the host.
    assert.strictEqual(identifyHostProcess(1).isHost, false);
  } finally {
    if (child.pid && processAlive(child.pid)) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('processAlive reports a process it may not signal as alive', () => {
  // EPERM means "exists but not yours"; treating it as dead would route an
  // unsignalable PID straight into the kill path.
  assert.strictEqual(processAlive(1), true);
});

test('removeHostPidFile only deletes a PID file that still names the killed process', () => {
  const { dir, socket } = tmpSocket('wd-pidclean-');
  try {
    fs.writeFileSync(pidFilePathForSocket(socket), '4242\n');
    assert.strictEqual(removeHostPidFile(socket, 9999), false, 'must not delete another host\'s PID file');
    assert.ok(fs.existsSync(pidFilePathForSocket(socket)));

    assert.strictEqual(removeHostPidFile(socket, 4242), true);
    assert.strictEqual(fs.existsSync(pidFilePathForSocket(socket)), false);

    assert.strictEqual(removeHostPidFile(socket, 4242), false, 'a missing PID file is not an error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeHost reassembles a response split across reads', async () => {
  // Without reassembly a perfectly healthy host whose reply is split over two
  // reads is classified wedged -- and an operator SIGKILLs it.
  const { dir, socket } = tmpSocket('wd-split-');
  const server = net.createServer((c) => {
    c.on('error', () => { /* the probe may hang up first */ });
    c.on('data', () => {
      c.write('{"id":1,"success":true,"result":{"pong":tr');
      setTimeout(() => { if (!c.destroyed) c.write('ue,"pid":4321,"uptimeMs":5}}\n'); }, 50);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const result = await probeHost(socket, 2000);
    assert.strictEqual(result.state, 'alive');
    assert.strictEqual(result.liveness?.pong, true);
    assert.strictEqual(result.pid, 4321);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeHost reassembles a response delivered one byte at a time', async () => {
  const { dir, socket } = tmpSocket('wd-drip-');
  const payload = JSON.stringify({ id: 1, success: true, result: { pong: true, pid: 77 } }) + '\n';
  const server = net.createServer((c) => {
    c.on('error', () => { /* the probe may hang up first */ });
    c.on('data', () => {
      let i = 0;
      const timer = setInterval(() => {
        if (i >= payload.length || c.destroyed) { clearInterval(timer); return; }
        c.write(payload[i++]);
      }, 1);
      c.on('close', () => clearInterval(timer));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const result = await probeHost(socket, 5000);
    assert.strictEqual(result.state, 'alive');
    assert.strictEqual(result.pid, 77);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeHost bounds the response buffer instead of growing it for the whole timeout', async () => {
  const { dir, socket } = tmpSocket('wd-unbounded-');
  const server = net.createServer((c) => {
    const blob = 'a'.repeat(64 * 1024); // never a newline
    let timer: NodeJS.Timeout | undefined;
    const stop = () => { if (timer) clearInterval(timer); c.destroy(); };
    c.on('error', stop);   // the probe hangs up mid-write; that is the point
    c.on('close', stop);
    c.on('data', () => {
      timer = setInterval(() => { if (c.destroyed) { stop(); return; } c.write(blob); }, 1);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const startedAt = Date.now();
    const result = await probeHost(socket, 10000);
    assert.strictEqual(result.state, 'wedged');
    assert.match(result.detail, /without completing a hostPing response/);
    assert.ok(Date.now() - startedAt < 9000, 'must bail on the size cap, not wait out the timeout');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('runCli reports a live host as JSON and exits zero', async () => {
  const { dir, socket } = tmpSocket('wd-cli-alive-');
  const original = process.env.CHROME_CONTROLLER_SOCKET;
  // runCli reads the REAL socket path. Without this override a --recover test
  // would SIGKILL the developer's or CI runner's own native host.
  process.env.CHROME_CONTROLLER_SOCKET = socket;
  const host = new NativeMessagingHost(socket);
  await host.ready;

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: unknown) => { lines.push(String(msg)); };
  try {
    const code = await runCli(['--json']);
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(lines.join('\n')) as Record<string, unknown>;
    assert.strictEqual(parsed.state, 'alive');
    assert.strictEqual(parsed.pid, process.pid);
    assert.strictEqual(parsed.recovery, undefined, 'no recovery without --recover');
  } finally {
    console.log = originalLog;
    host.close();
    if (original === undefined) delete process.env.CHROME_CONTROLLER_SOCKET;
    else process.env.CHROME_CONTROLLER_SOCKET = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCli exits non-zero and explains itself when no host is running', async () => {
  const { dir, socket } = tmpSocket('wd-cli-down-');
  const original = process.env.CHROME_CONTROLLER_SOCKET;
  process.env.CHROME_CONTROLLER_SOCKET = socket;
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: unknown) => { lines.push(String(msg)); };
  try {
    const code = await runCli([]);
    assert.strictEqual(code, 1);
    assert.match(lines.join('\n'), /state:\s+down/);
  } finally {
    console.log = originalLog;
    if (original === undefined) delete process.env.CHROME_CONTROLLER_SOCKET;
    else process.env.CHROME_CONTROLLER_SOCKET = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCli --recover on a wedged host with no PID file signals nothing', async () => {
  const { dir, socket } = tmpSocket('wd-cli-nopid-');
  const original = process.env.CHROME_CONTROLLER_SOCKET;
  process.env.CHROME_CONTROLLER_SOCKET = socket;
  const server = net.createServer(() => { /* accept and ignore: wedged */ });
  await new Promise<void>((resolve) => server.listen(socket, resolve));

  const signalled: number[] = [];
  const originalKill = process.kill.bind(process);
  (process as unknown as { kill: unknown }).kill = (target: number, signal?: number | string) => {
    if (signal !== 0) signalled.push(target);
    return originalKill(target, signal as never);
  };
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: unknown) => { lines.push(String(msg)); };
  try {
    const code = await runCli(['--recover', '--timeout', '300']);
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(signalled, [], 'no PID file means nothing may be signalled');
    assert.match(lines.join('\n'), /no PID file was found/);
  } finally {
    console.log = originalLog;
    (process as unknown as { kill: unknown }).kill = originalKill;
    server.close();
    if (original === undefined) delete process.env.CHROME_CONTROLLER_SOCKET;
    else process.env.CHROME_CONTROLLER_SOCKET = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
