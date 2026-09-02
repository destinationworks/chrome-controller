import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const extensionId = process.argv[2];

if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
  console.error('Error: You must provide a valid 32-character Chrome extension ID.');
  console.error('Usage: npm run install-host <extension-id>');
  console.error('Example: npm run install-host gocbenlgkgeaiifofilndbnaeigpplca');
  process.exit(1);
}

const nativeHostsDir = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
  : path.join(os.homedir(), '.config/google-chrome/NativeMessagingHosts');

fs.mkdirSync(nativeHostsDir, { recursive: true });

const launcherPath = path.join(rootDir, 'scripts/native-host-launcher.sh');
try {
  fs.chmodSync(launcherPath, 0o755);
} catch { /* ignore */ }

const manifestContent = {
  name: 'com.dst.chrome_controller',
  description: 'Chrome Controller Native Messaging Host for AI Agents',
  path: launcherPath,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
};

const targetPath = path.join(nativeHostsDir, 'com.dst.chrome_controller.json');
fs.writeFileSync(targetPath, JSON.stringify(manifestContent, null, 2), 'utf8');

console.log(`Native Messaging Host manifest installed to:\n  ${targetPath}`);
console.log(`Allowed extension origin:\n  chrome-extension://${extensionId}/`);
console.log(`Points to launcher:\n  ${launcherPath}`);
