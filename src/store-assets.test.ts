import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
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
  const contentScript = await readFile(path.join(repoRoot, 'Chrome Extension', 'content.js'), 'utf8');
  const contentCss = await readFile(path.join(repoRoot, 'Chrome Extension', 'content.css'), 'utf8');
  const { screenshotHtml } = await import('../scripts/generate-store-assets.js');
  assert.equal(provenance.source, 'live-extension');
  assert.equal(provenance.manifestName, manifest.name);
  assert.match(provenance.capturedManifestVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(provenance.demoHtmlSha256, createHash('sha256').update(screenshotHtml(iconSvg)).digest('hex'));
  assert.equal(provenance.contentScriptSha256, createHash('sha256').update(contentScript).digest('hex'));
  assert.equal(provenance.contentCssSha256, createHash('sha256').update(contentCss).digest('hex'));
  assert.deepEqual({ width: provenance.width, height: provenance.height }, { width: 1280, height: 800 });
  assert.ok(provenance.snapshotElementCount > 0);
  assert.ok(provenance.overlayBadgeCount > 0);
  assert.equal(provenance.hudExpanded, true);
  assert.equal(provenance.sha256, createHash('sha256').update(image).digest('hex'));
});

const repositoryUrl = 'https://github.com/destinationworks/chrome-controller';

// The console field a section of the listing copy is pasted into: the first ```text block
// after the numbered heading that names it.
function listingField(markdown: string, heading: string): string {
  const start = markdown.search(new RegExp(`^## \\d+\\. ${heading}`, 'm'));
  assert.ok(start >= 0, `listing copy has no "${heading}" section`);
  const block = /```text\n([\s\S]*?)\n```/.exec(markdown.slice(start));
  assert.ok(block, `"${heading}" section has no text block`);
  return block[1];
}

test('store listing copy fits the console limits and matches the shipped version', async () => {
  const listing = await readFile(path.join(repoRoot, 'docs', 'chrome-web-store-listing.md'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'Chrome Extension', 'manifest.json'), 'utf8'));
  const summary = listingField(listing, 'Summary');
  assert.ok(summary.length > 0 && summary.length <= 132, `summary is ${summary.length} characters; the console allows 132`);
  assert.ok(!summary.includes('\n'), 'the summary field is a single line');
  const description = listingField(listing, 'Detailed Description');
  assert.ok(description.length <= 16_000, `description is ${description.length} characters; the console allows 16000`);
  assert.match(description, new RegExp(`WHAT'S NEW IN ${manifest.version.replaceAll('.', '\\.')}\\n`), 'release notes must name the manifest version');
});

test('store listing links point at this repository and its privacy policy file exists', async () => {
  const listing = await readFile(path.join(repoRoot, 'docs', 'chrome-web-store-listing.md'), 'utf8');
  const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
  for (const [url] of listing.matchAll(/https:\/\/github\.com\/[^\s)`"]+/g)) {
    assert.ok(url === repositoryUrl || url.startsWith(`${repositoryUrl}/`) || url === `${repositoryUrl}.git`, `foreign GitHub link: ${url}`);
  }
  assert.equal(listingField(listing, 'Homepage URL'), repositoryUrl);
  assert.equal(listingField(listing, 'Support URL'), `${repositoryUrl}/issues`);
  const privacyUrl = listingField(listing, 'Privacy Policy URL');
  const privacyPrefix = `${repositoryUrl}/blob/main/`;
  assert.ok(privacyUrl.startsWith(privacyPrefix), `privacy policy must be served from this repository: ${privacyUrl}`);
  await access(path.join(repoRoot, privacyUrl.slice(privacyPrefix.length)));
  const storeId = /chromewebstore\.google\.com\/detail\/[^/]+\/([a-p]{32})/.exec(readme)?.[1];
  assert.ok(storeId, 'README links the store item');
  assert.match(listing, new RegExp(`npm run install-host ${storeId}\\n`), 'install instructions must register the store item ID');
});
