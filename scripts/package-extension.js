import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const extensionDir = path.join(rootDir, 'Chrome Extension');

fs.mkdirSync(distDir, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
const version = manifest.version || '1.1.0';
const zipName = `chrome-extension-v${version}.zip`;
const zipPath = path.join(distDir, zipName);

if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

try {
  execSync(`cd "${extensionDir}" && zip -r "${zipPath}" . -x "*.DS_Store"`, { stdio: 'inherit' });
  console.log(`\nSuccessfully packaged Chrome Extension for Web Store publishing:`);
  console.log(`  Package: ${zipPath}`);
  console.log(`  Version: ${version}`);
  console.log(`  Publisher: ${manifest.author || 'dst.works@gmail.com'}`);
} catch (err) {
  console.error('Failed to create zip package:', err);
  process.exit(1);
}
