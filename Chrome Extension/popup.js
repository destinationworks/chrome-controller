document.addEventListener('DOMContentLoaded', () => {
  const extId = chrome.runtime.id || 'gocbenlgkgeaiifofilndbnaeigpplca';
  const installCmd = `npm run install-host ${extId}`;

  const statusBadge = document.getElementById('status-badge');
  const statusText = document.getElementById('status-text');
  const extensionIdEl = document.getElementById('extension-id');
  const setupCommandEl = document.getElementById('setup-command');
  const copyIdBtn = document.getElementById('copy-id-btn');
  const copyCmdBtn = document.getElementById('copy-cmd-btn');
  const btnGithub = document.getElementById('btn-github-doc');
  const btnWebstore = document.getElementById('btn-webstore-link');

  if (extensionIdEl) extensionIdEl.textContent = extId;
  if (setupCommandEl) setupCommandEl.textContent = installCmd;

  function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = orig;
        btn.disabled = false;
      }, 1500);
    }).catch((err) => {
      console.error('Failed to copy to clipboard:', err);
    });
  }

  if (copyIdBtn) {
    copyIdBtn.addEventListener('click', () => copyText(extId, copyIdBtn));
  }

  if (copyCmdBtn) {
    copyCmdBtn.addEventListener('click', () => copyText(installCmd, copyCmdBtn));
  }

  if (btnGithub) {
    btnGithub.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'https://github.com/dst0/chrome-controller' });
    });
  }

  if (btnWebstore) {
    btnWebstore.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'https://chromewebstore.google.com/detail/p-agent-extension/gocbenlgkgeaiifofilndbnaeigpplca' });
    });
  }

  function updateStatus() {
    try {
      chrome.runtime.sendMessage({ action: 'getConnectionState' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.success) {
          if (statusBadge) {
            statusBadge.className = 'badge badge-disconnected';
            statusBadge.textContent = 'Disconnected';
          }
          if (statusText) statusText.textContent = 'Local bridge not running';
          return;
        }

        if (res.nativeConnected) {
          if (statusBadge) {
            statusBadge.className = 'badge badge-connected';
            statusBadge.textContent = 'Connected (Native)';
          }
          if (statusText) statusText.textContent = 'Native Messaging Host Active';
        } else if (res.wsConnected) {
          if (statusBadge) {
            statusBadge.className = 'badge badge-connected';
            statusBadge.textContent = 'Connected (Relay)';
          }
          if (statusText) statusText.textContent = 'WebSocket Relay Active';
        } else {
          if (statusBadge) {
            statusBadge.className = 'badge badge-disconnected';
            statusBadge.textContent = 'Disconnected';
          }
          if (statusText) statusText.textContent = 'Run host install command below';
        }
      });
    } catch (e) {
      if (statusBadge) {
        statusBadge.className = 'badge badge-disconnected';
        statusBadge.textContent = 'Disconnected';
      }
      if (statusText) statusText.textContent = 'Bridge unavailable';
    }
  }

  updateStatus();
});
