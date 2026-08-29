import { execSync } from 'node:child_process';

const justification = "Required for local AI agent browser automation, tab management, CDP interaction, and HUD overlay.";
const description = "Chrome Controller connects local AI coding agents to your browser via Native Messaging IPC. It enables automated tab management, element interaction, CDP input, and visual HUD overlays.";

function setClipboard(text) {
  execSync('pbcopy', { input: text });
}

function pasteAndTab(count = 1) {
  setClipboard(justification);
  for (let i = 0; i < count; i++) {
    execSync(`osascript -e '
      tell application "Google Chrome" to activate
      delay 0.2
      tell application "System Events"
        keystroke "v" using command down
        delay 0.2
        key code 48 -- Tab key
        delay 0.2
      end tell
    '`);
  }
}

console.log('Automating paste into current Chrome form...');
pasteAndTab(10);
console.log('Done pasting justifications into 10 form fields!');
