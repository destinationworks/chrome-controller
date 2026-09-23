/**
 * Native Messaging host watchdog.
 *
 * The host is spawned and owned by Chrome; nothing supervises it. A host whose
 * event loop stops turning keeps the IPC socket bound and accepts connections,
 * so every agent command hangs until its own timeout instead of failing fast,
 * and SIGTERM is swallowed because the JS handler never runs. This probe
 * distinguishes that wedged state from a healthy or absent host, and can
 * escalate TERM -> KILL to clear it.
 */

import net from 'node:net';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getSocketPath, readHostPid, pidFilePathForSocket } from './native-host.js';

export type HostState = 'alive' | 'wedged' | 'stale-socket' | 'down';

export interface ProbeResult {
  state: HostState;
  socketPath: string;
  pid: number | null;
  detail: string;
  liveness?: Record<string, unknown>;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 3000;

/**
 * Sends a locally-answered `hostPing` over the IPC socket. `hostPing` never
 * reaches Chrome, so a timeout here means the host process itself is not
 * servicing its event loop, not that the browser is busy.
 */
export function probeHost(
  socketPath: string = getSocketPath(),
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const pid = readHostPid(socketPath);

  if (process.platform !== 'win32' && !fs.existsSync(socketPath)) {
    return Promise.resolve({
      state: 'down',
      socketPath,
      pid,
      detail: 'No IPC socket exists; no native host is running.',
    });
  }

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        state: 'wedged',
        socketPath,
        pid,
        detail: `Socket accepted the connection but hostPing did not answer within ${timeoutMs}ms; the host event loop is not turning.`,
      });
    }, timeoutMs);

    const client = net.connect(socketPath, () => {
      client.write(JSON.stringify({ id: 1, action: 'hostPing' }) + '\n');
    });

    // A response can arrive split across reads, so it is reassembled here.
    // The buffer is capped: a host that streams bytes without ever sending a
    // newline must not be able to grow this unboundedly for the whole timeout.
    const MAX_RESPONSE_BYTES = 1024 * 1024;
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_RESPONSE_BYTES) {
        finish({
          state: 'wedged',
          socketPath,
          pid,
          detail: `Host sent more than ${MAX_RESPONSE_BYTES} bytes without completing a hostPing response.`,
        });
        return;
      }
      if (!buffer.includes('\n')) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as {
          success?: boolean;
          result?: Record<string, unknown>;
          error?: string;
        };
        if (parsed.success && parsed.result) {
          finish({
            state: 'alive',
            socketPath,
            pid: (parsed.result.pid as number | undefined) ?? pid,
            detail: 'Host answered hostPing.',
            liveness: parsed.result,
          });
          return;
        }
        // A parseable response — even an error — proves the event loop is
        // turning, so this host is responsive, not wedged. A host predating
        // hostPing answers "Unknown action" and is simply out of date.
        const error = parsed.error ?? 'unknown error';
        finish({
          state: 'alive',
          socketPath,
          pid,
          detail: /unknown action/i.test(error)
            ? 'Host is responsive but predates the hostPing liveness probe; restart it (re-enable the extension) to get full liveness detail.'
            : `Host is responsive but rejected hostPing: ${error}`,
        });
      } catch {
        finish({
          state: 'wedged',
          socketPath,
          pid,
          detail: 'Host returned an unparseable hostPing response.',
        });
      }
    });

    client.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') {
        finish({
          state: 'stale-socket',
          socketPath,
          pid,
          detail: 'Socket file exists but nothing is listening; a dead host left it behind. The next host start removes it automatically.',
        });
        return;
      }
      if (error.code === 'ENOENT') {
        finish({
          state: 'down',
          socketPath,
          pid,
          detail: 'No IPC socket exists; no native host is running.',
        });
        return;
      }
      finish({
        state: 'wedged',
        socketPath,
        pid,
        detail: `IPC connection failed: ${error.code ?? error.message}`,
      });
    });
  });
}

/**
 * Confirms a PID really is a Chrome Controller native host before it is
 * signalled. A PID file survives SIGKILL and the OS recycles PIDs, so
 * recovering on the file's word alone can kill an unrelated process.
 */
export function identifyHostProcess(pid: number): { isHost: boolean; command: string | null } {
  if (process.platform === 'win32') return { isHost: false, command: null };
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (!command) return { isHost: false, command: null };
    return { isHost: /native-host\.(?:js|ts)\b/.test(command), command };
  } catch {
    return { isHost: false, command: null };
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface RecoveryResult {
  attempted: boolean;
  killed: boolean;
  escalatedToSigkill: boolean;
  detail: string;
}

/**
 * Escalates SIGTERM -> SIGKILL against a wedged host. SIGTERM is tried first so
 * a host that can still run its handler cleans up its socket and PID file; a
 * wedged loop never runs that handler, which is why SIGKILL must follow.
 */
export async function recoverHost(
  pid: number,
  options: {
    sigtermGraceMs?: number;
    sleep?: (ms: number) => Promise<void>;
    identify?: (pid: number) => { isHost: boolean; command: string | null };
  } = {},
): Promise<RecoveryResult> {
  const graceMs = options.sigtermGraceMs ?? 2000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const identify = options.identify ?? identifyHostProcess;

  if (!processAlive(pid)) {
    return { attempted: false, killed: false, escalatedToSigkill: false, detail: `PID ${pid} is not running.` };
  }

  const identity = identify(pid);
  if (!identity.isHost) {
    return {
      attempted: false,
      killed: false,
      escalatedToSigkill: false,
      detail:
        `Refusing to signal PID ${pid}: it is not a Chrome Controller native host` +
        `${identity.command ? ` (running: ${identity.command})` : ' (process could not be identified)'}. ` +
        'The PID file is probably stale and the PID has been reused.',
    };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    return {
      attempted: true,
      killed: false,
      escalatedToSigkill: false,
      detail: `SIGTERM to PID ${pid} failed: ${(error as Error).message}`,
    };
  }

  await sleep(graceMs);

  if (!processAlive(pid)) {
    return { attempted: true, killed: true, escalatedToSigkill: false, detail: `PID ${pid} exited on SIGTERM.` };
  }

  // The host may have exited during the grace window and the PID been reused by
  // an unrelated process; SIGKILL is unblockable, so re-confirm before sending.
  if (!identify(pid).isHost) {
    return {
      attempted: true,
      killed: false,
      escalatedToSigkill: false,
      detail: `PID ${pid} is no longer a native host after SIGTERM; not escalating to SIGKILL.`,
    };
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    return {
      attempted: true,
      killed: false,
      escalatedToSigkill: true,
      detail: `SIGKILL to PID ${pid} failed: ${(error as Error).message}`,
    };
  }

  await sleep(250);
  const killed = !processAlive(pid);
  return {
    attempted: true,
    killed,
    escalatedToSigkill: true,
    detail: killed
      ? `PID ${pid} swallowed SIGTERM (wedged event loop) and was killed with SIGKILL.`
      : `PID ${pid} survived SIGKILL; it is likely blocked in the kernel.`,
  };
}

/** Removes a PID file only when it still names the process we just killed. */
export function removeHostPidFile(socketPath: string, expectedPid: number): boolean {
  if (readHostPid(socketPath) !== expectedPid) return false;
  try {
    fs.unlinkSync(pidFilePathForSocket(socketPath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Could not remove stale PID file: ${(error as Error).message}`);
    }
    return false;
  }
}

export function exitCodeForState(state: HostState): number {
  return state === 'alive' ? 0 : 1;
}

export function formatReport(probe: ProbeResult, recovery?: RecoveryResult): string {
  const lines = [
    `state:  ${probe.state}`,
    `socket: ${probe.socketPath}`,
    `pid:    ${probe.pid ?? 'unknown'}`,
    `detail: ${probe.detail}`,
  ];
  if (probe.liveness) {
    const l = probe.liveness;
    lines.push(
      `uptime: ${Math.round(Number(l.uptimeMs ?? 0) / 1000)}s`,
      `chrome: connected=${l.chromeConnected} lastMessageAt=${l.lastChromeMessageAt ?? 'never'} pending=${l.pendingRequests}`,
    );
  }
  if (probe.state === 'wedged' && !recovery) {
    lines.push('hint:   run with --recover to escalate SIGTERM -> SIGKILL, then re-enable the extension in chrome://extensions.');
  }
  if (recovery) lines.push(`recovery: ${recovery.detail}`);
  return lines.join('\n');
}

export async function runCli(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  const recover = argv.includes('--recover');
  const timeoutArg = argv.indexOf('--timeout');
  const timeoutMs = timeoutArg >= 0 ? Number(argv[timeoutArg + 1]) : DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    console.error('Watchdog --timeout must be an integer from 1 to 120000 milliseconds');
    return 2;
  }

  const socketPath = getSocketPath();
  const probe = await probeHost(socketPath, timeoutMs);

  let recovery: RecoveryResult | undefined;
  if (recover && probe.state === 'wedged' && probe.pid !== null) {
    recovery = await recoverHost(probe.pid);
    // A SIGKILLed host cannot clean up after itself, so the PID file would
    // outlive it and point at a PID the OS is free to reuse.
    if (recovery.killed) removeHostPidFile(socketPath, probe.pid);
  } else if (recover && probe.state === 'wedged') {
    recovery = {
      attempted: false,
      killed: false,
      escalatedToSigkill: false,
      detail: 'Host is wedged but no PID file was found; kill the Chrome-spawned native-host.js process manually.',
    };
  }

  console.log(json ? JSON.stringify({ ...probe, recovery }, null, 2) : formatReport(probe, recovery));
  return exitCodeForState(probe.state);
}

const isMain = /(?:^|[\\/])watchdog\.(?:js|ts)$/.test(process.argv[1] || '');
if (isMain) {
  void runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
