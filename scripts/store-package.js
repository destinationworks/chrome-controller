// Builds the store ZIP from one commit's "Chrome Extension" tree. `git archive` with the
// commit's own timestamp makes the bytes reproducible, so the digest printed before upload
// identifies exactly what was sent. Uncommitted extension changes are refused: they would
// ship bytes no commit records.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const EXTENSION_DIR = 'Chrome Extension';

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { maxBuffer: 64 * 1024 * 1024 });
}

// Reads a ZIP's files: name (UTF-8), contents and the UTC mtime from the extended-timestamp
// field. Done here rather than with unzip, which mangles UTF-8 names and expands wildcards.
export function readZip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('Package is not a ZIP archive');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Package ZIP has a damaged central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const extra = buffer.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    let mtime;
    for (let cursor = 0; cursor + 4 <= extra.length;) {
      const id = extra.readUInt16LE(cursor);
      const size = extra.readUInt16LE(cursor + 2);
      if (id === 0x5455 && size >= 5 && (extra[cursor + 4] & 1)) mtime = extra.readUInt32LE(cursor + 5);
      cursor += 4 + size;
    }
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`Package entry ${name} uses unsupported compression ${method}`);
    files.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw), mtime });
  }
  return files;
}

export function buildPackage({ repoRoot, outDir, commit = 'HEAD' }) {
  const sha = git(repoRoot, ['rev-parse', '--verify', `${commit}^{commit}`]).toString().trim();
  if (commit === 'HEAD') {
    const dirty = git(repoRoot, ['status', '--porcelain', '--', EXTENSION_DIR]).toString().trim();
    if (dirty) throw new Error(`"${EXTENSION_DIR}" has uncommitted changes; commit them before packaging:\n${dirty}`);
  }
  const committedAt = git(repoRoot, ['show', '-s', '--format=%cI', sha]).toString().trim();
  const manifest = JSON.parse(git(repoRoot, ['show', `${sha}:${EXTENSION_DIR}/manifest.json`]).toString());
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `chrome-extension-v${manifest.version}-${sha.slice(0, 12)}.zip`);
  git(repoRoot, ['archive', '--format=zip', `--mtime=${committedAt}`, '-o', zipPath, `${sha}:${EXTENSION_DIR}`]);

  // The archive must hold exactly the committed files, byte for byte: export-ignore or
  // eol attributes would otherwise ship something no commit contains.
  const expected = git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', `${sha}:${EXTENSION_DIR}`]).toString().split('\0').filter(Boolean).sort();
  const bytes = fs.readFileSync(zipPath);
  const files = readZip(bytes);
  if (JSON.stringify(files.map((file) => file.name).sort()) !== JSON.stringify(expected)) {
    throw new Error(`Package entries differ from ${EXTENSION_DIR} at ${sha.slice(0, 12)}`);
  }
  for (const file of files) {
    if (!file.data.equals(git(repoRoot, ['show', `${sha}:${EXTENSION_DIR}/${file.name}`]))) throw new Error(`Package entry ${file.name} differs from the commit`);
  }
  return {
    path: zipPath,
    commit: sha,
    version: manifest.version,
    manifest,
    entries: expected,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// Chrome compares dotted versions numerically; the store refuses an upload that is not newer.
export function isNewerVersion(candidate, current) {
  if (!current) return true;
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
