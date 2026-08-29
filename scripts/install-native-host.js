import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const extensionId = process.argv[2];

const nativeHostsDir = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/NativeMessagingHosts'
);

fs.mkdirSync(nativeHostsDir, { recursive: true });

const launcherPath = path.join(rootDir, 'scripts/native-host-launcher.sh');

const origins = [];

if (extensionId) {
  origins.push(`chrome-extension://${extensionId}/`);
}

const manifestContent = {
  name: 'com.dst.chrome_controller',
  description: 'Chrome Controller Native Messaging Host for AI Agents',
  path: launcherPath,
  type: 'stdio',
  allowed_origins: origins
};

const targetPath = path.join(nativeHostsDir, 'com.dst.chrome_controller.json');
fs.writeFileSync(targetPath, JSON.stringify(manifestContent, null, 2), 'utf8');

console.log(`Native Messaging Host manifest installed to:\n  ${targetPath}`);
console.log(`Points to launcher:\n  ${launcherPath}`);
