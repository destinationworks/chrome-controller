import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storeAssetsDir = path.join(repoRoot, 'store-assets');

function pngDimensions(buffer: Buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(buffer.subarray(0, 8).equals(signature), 'expected a PNG signature');
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function decodeRgbaPng(buffer: Buffer) {
  const { width, height } = pngDimensions(buffer);
  assert.equal(buffer[24], 8, 'expected 8-bit PNG channels');
  assert.equal(buffer[25], 6, 'expected RGBA PNG color type');
  assert.equal(buffer[28], 0, 'expected a non-interlaced PNG');
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const filtered = inflateSync(Buffer.concat(chunks));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset];
    sourceOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[sourceOffset + x];
      const destination = y * stride + x;
      const left = x >= bytesPerPixel ? pixels[destination - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[destination - stride] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[destination - stride - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const estimate = left + up - upperLeft;
        const leftDistance = Math.abs(estimate - left);
        const upDistance = Math.abs(estimate - up);
        const upperLeftDistance = Math.abs(estimate - upperLeft);
        predictor = leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
      } else assert.equal(filter, 0, `unsupported PNG filter ${filter}`);
      pixels[destination] = (raw + predictor) & 0xff;
    }
    sourceOffset += stride;
  }
  return { width, height, pixels };
}

function jpegDimensions(buffer: Buffer) {
  assert.equal(buffer.readUInt16BE(0), 0xffd8, 'expected a JPEG SOI marker');
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < buffer.length) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const segmentLength = buffer.readUInt16BE(offset);
    if (startOfFrameMarkers.has(marker)) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += segmentLength;
  }
  assert.fail('JPEG did not contain a start-of-frame marker');
}

test('store icon is the rendered 128px product mark, not a tiny placeholder', async () => {
  const icon = await readFile(path.join(storeAssetsDir, 'store-icon-128.png'));
  const decoded = decodeRgbaPng(icon);
  assert.deepEqual({ width: decoded.width, height: decoded.height }, { width: 128, height: 128 });
  assert.ok(icon.length > 4_000, `expected detailed icon artwork, got only ${icon.length} bytes`);
  const visible = [];
  const colors = new Set();
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = 0; x < decoded.width; x += 1) {
      const offset = (y * decoded.width + x) * 4;
      const alpha = decoded.pixels[offset + 3];
      if (alpha > 8) {
        visible.push({ x, y });
        colors.add(decoded.pixels.subarray(offset, offset + 4).toString('hex'));
      }
    }
  }
  assert.ok(visible.length > 2_000, 'expected substantial visible icon artwork');
  assert.ok(colors.size > 64, `expected gradient/detail diversity, got ${colors.size} colors`);
  assert.ok(Math.min(...visible.map((pixel) => pixel.x)) >= 15, 'expected transparent left safe area');
  assert.ok(Math.max(...visible.map((pixel) => pixel.x)) <= 112, 'expected transparent right safe area');
  assert.ok(Math.min(...visible.map((pixel) => pixel.y)) >= 15, 'expected transparent top safe area');
  assert.ok(Math.max(...visible.map((pixel) => pixel.y)) <= 112, 'expected transparent bottom safe area');
});

for (const asset of [
  { name: 'screenshot-1280x800.jpg', width: 1280, height: 800, minimumBytes: 40_000 },
  { name: 'small-promo-440x280.jpg', width: 440, height: 280, minimumBytes: 10_000 },
  { name: 'marquee-promo-1400x560.jpg', width: 1400, height: 560, minimumBytes: 35_000 },
]) {
  test(`${asset.name} has its Web Store dimensions and non-placeholder detail`, async () => {
    const image = await readFile(path.join(storeAssetsDir, asset.name));
    assert.deepEqual(jpegDimensions(image), { width: asset.width, height: asset.height });
    assert.ok(image.length > asset.minimumBytes, `expected detailed artwork, got only ${image.length} bytes`);
  });
}

test('store screenshot is a verified live-extension capture', async () => {
  const image = await readFile(path.join(storeAssetsDir, 'screenshot-1280x800.jpg'));
  const provenance = JSON.parse(await readFile(path.join(storeAssetsDir, 'screenshot-capture.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'Chrome Extension', 'manifest.json'), 'utf8'));
  const iconSvg = await readFile(path.join(repoRoot, 'Chrome Extension', 'icon128.svg'), 'utf8');
  const { screenshotHtml } = await import('../scripts/generate-store-assets.js');
  assert.equal(provenance.source, 'live-extension');
  assert.equal(provenance.manifestName, manifest.name);
  assert.equal(provenance.manifestVersion, manifest.version);
  assert.equal(provenance.demoHtmlSha256, createHash('sha256').update(screenshotHtml(iconSvg)).digest('hex'));
  assert.deepEqual({ width: provenance.width, height: provenance.height }, { width: 1280, height: 800 });
  assert.ok(provenance.snapshotElementCount > 0);
  assert.ok(provenance.overlayBadgeCount > 0);
  assert.equal(provenance.hudExpanded, true);
  assert.equal(provenance.sha256, createHash('sha256').update(image).digest('hex'));
});
