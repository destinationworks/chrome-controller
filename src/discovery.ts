import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const DISCOVERY_DIR = path.join(os.homedir(), '.chrome-controller');
export const MIN_RELAY_KEY_BYTES = 32;
const MAX_DISCOVERY_BYTES = 64 * 1024;
const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface DiscoveryInfo {
  httpPort: number;
  wsPort: number;
  apiKey: string;
  pid: number;
  startedAt: string;
}

export function normalizeInstanceName(instance: string): string {
  if (!INSTANCE_PATTERN.test(instance)) {
    throw new Error('Chrome Controller instance must be 1-64 letters, digits, dots, underscores, or hyphens');
  }
  return instance;
}

export function generateRelayApiKey(): string {
  return randomBytes(MIN_RELAY_KEY_BYTES).toString('base64url');
}

export function validateRelayApiKey(apiKey: unknown): string {
  if (typeof apiKey !== 'string' || Buffer.byteLength(apiKey, 'utf8') < MIN_RELAY_KEY_BYTES) {
    throw new Error(`Chrome Controller relay API key must contain at least ${MIN_RELAY_KEY_BYTES} bytes`);
  }
  return apiKey;
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

function validateDiscoveryInfo(value: unknown): DiscoveryInfo {
  if (!value || typeof value !== 'object') throw new Error('Invalid Chrome Controller discovery payload');
  const info = value as Partial<DiscoveryInfo>;
  if (!validPort(info.httpPort) || !validPort(info.wsPort)) {
    throw new Error('Chrome Controller discovery ports are invalid');
  }
  const apiKey = validateRelayApiKey(info.apiKey);
  if (!Number.isSafeInteger(info.pid) || Number(info.pid) <= 0) {
    throw new Error('Chrome Controller discovery PID is invalid');
  }
  if (typeof info.startedAt !== 'string' || !Number.isFinite(Date.parse(info.startedAt))) {
    throw new Error('Chrome Controller discovery start time is invalid');
  }
  return {
    httpPort: info.httpPort,
    wsPort: info.wsPort,
    apiKey,
    pid: Number(info.pid),
    startedAt: info.startedAt,
  };
}

function assertOwnedByCurrentUser(stats: fs.Stats, label: string): void {
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user`);
  }
}

function ensurePrivateDiscoveryDir(): void {
  fs.mkdirSync(DISCOVERY_DIR, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(DISCOVERY_DIR);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('Chrome Controller discovery path must be a real directory');
  }
  assertOwnedByCurrentUser(stats, 'Chrome Controller discovery directory');
  if ((stats.mode & 0o077) !== 0) fs.chmodSync(DISCOVERY_DIR, 0o700);
}

function assertPrivateDiscoveryDir(): void {
  const stats = fs.lstatSync(DISCOVERY_DIR);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('Chrome Controller discovery path must be a real directory');
  }
  assertOwnedByCurrentUser(stats, 'Chrome Controller discovery directory');
  if ((stats.mode & 0o077) !== 0) {
    throw new Error('Chrome Controller discovery directory is not private');
  }
}

function discoveryPath(instance: string): string {
  return path.join(DISCOVERY_DIR, `${normalizeInstanceName(instance)}.json`);
}

export function writeDiscovery(instance: string, value: DiscoveryInfo): void {
  const info = validateDiscoveryInfo(value);
  ensurePrivateDiscoveryDir();
  const target = discoveryPath(instance);
  const temp = path.join(
    DISCOVERY_DIR,
    `.${normalizeInstanceName(instance)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore cleanup error */ }
    }
    try { fs.unlinkSync(temp); } catch { /* ignore cleanup error */ }
    throw error;
  }
}

export function readDiscovery(instance: string): DiscoveryInfo | null {
  let fd: number | undefined;
  try {
    assertPrivateDiscoveryDir();
    const file = discoveryPath(instance);
    const noFollow = 'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size > MAX_DISCOVERY_BYTES) return null;
    assertOwnedByCurrentUser(stats, 'Chrome Controller discovery file');
    if ((stats.mode & 0o077) !== 0) return null;
    const raw = fs.readFileSync(fd, 'utf8');
    return validateDiscoveryInfo(JSON.parse(raw));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore cleanup error */ }
    }
  }
}

function discoveryInfoMatches(actual: DiscoveryInfo, expected: DiscoveryInfo): boolean {
  return actual.httpPort === expected.httpPort &&
    actual.wsPort === expected.wsPort &&
    actual.apiKey === expected.apiKey &&
    actual.pid === expected.pid &&
    actual.startedAt === expected.startedAt;
}

export function removeDiscovery(instance: string, expected?: DiscoveryInfo): void {
  let fd: number | undefined;
  try {
    assertPrivateDiscoveryDir();
    const file = discoveryPath(instance);
    const noFollow = 'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const openedStats = fs.fstatSync(fd);
    if (!openedStats.isFile()) return;
    assertOwnedByCurrentUser(openedStats, 'Chrome Controller discovery file');
    if ((openedStats.mode & 0o077) !== 0 || openedStats.size > MAX_DISCOVERY_BYTES) return;
    const actual = validateDiscoveryInfo(JSON.parse(fs.readFileSync(fd, 'utf8')));
    if (expected && !discoveryInfoMatches(actual, expected)) return;

    const currentStats = fs.lstatSync(file);
    if (currentStats.isSymbolicLink() || !currentStats.isFile()) return;
    if (currentStats.dev !== openedStats.dev || currentStats.ino !== openedStats.ino) return;
    fs.unlinkSync(file);
  } catch { /* ignore */ }
  finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore cleanup error */ }
    }
  }
}
