const ROOT_ID = 'chrome-controller-overlay-root';
const MAX_FEED_ITEMS = 5;
const TITLE_PREFIX = '🤖 ';
const ROBOT_FAVICON_ID = 'chrome-controller-robot-favicon';

const state = {
  cursor: { x: null, y: null },
  selected: false,
  typingTimer: null,
  originalTitle: null,
  originalFavicons: null,
  audioContext: null,
  audioMuted: true,
  lastSoundAt: 0,
  sparkleTimer: null,
  overlayHidden: false,
};

function truncate(value, length) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

function ensureOverlay() {
  let root = document.getElementById(ROOT_ID);
  if (root) return root;

  root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'chrome-controller-overlay-root';
  root.innerHTML = `
    <div class="chrome-controller-frame"></div>
    <div class="chrome-controller-sparkles" aria-hidden="true"></div>
    <div class="chrome-controller-cursor" aria-hidden="true">
      <span class="chrome-controller-cursor-core"></span>
      <span class="chrome-controller-cursor-ring"></span>
    </div>
    <section class="chrome-controller-hud" aria-live="polite">
      <div class="chrome-controller-status-row">
        <span class="chrome-controller-status-dot"></span>
        <span class="chrome-controller-status-glyph" aria-hidden="true">🤖</span>
        <button class="chrome-controller-audio-btn" aria-label="Unmute typing sounds" title="Unmute typing sounds">🔇</button>
        <span class="chrome-controller-status">Controller idle</span>
      </div>
      <div class="chrome-controller-settings">
        <label class="chrome-controller-settings-item">
          <input type="checkbox" class="chrome-controller-hide-toggle" />
          <span>Hide overlay</span>
        </label>
      </div>
      <div class="chrome-controller-tab">No controlled tab</div>
      <div class="chrome-controller-coords">x -, y -</div>
      <div class="chrome-controller-typing" hidden></div>
      <ol class="chrome-controller-feed"></ol>
    </section>
  `;

  const mount = document.body || document.documentElement;
  mount.appendChild(root);
  wireOverlayControls(root);
  return root;
}

function wireOverlayControls(root) {
  if (root.dataset.chromeControllerControlsWired === 'true') return;
  root.dataset.chromeControllerControlsWired = 'true';

  const audioBtn = root.querySelector('.chrome-controller-audio-btn');
  if (audioBtn) {
    audioBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setAudioMuted(!state.audioMuted);
    });
  }

  const hideToggle = root.querySelector('.chrome-controller-hide-toggle');
  if (hideToggle) {
    hideToggle.addEventListener('change', (e) => {
      e.stopPropagation();
      setOverlayHidden(e.target.checked);
    });
  }
}

function setRootClass(name, enabled) {
  ensureOverlay().classList.toggle(name, Boolean(enabled));
}

function setStatus(status, detail) {
  const root = ensureOverlay();
  const statusEl = root.querySelector('.chrome-controller-status');
  const label = detail ? `${status} - ${truncate(detail, 36)}` : status;
  statusEl.textContent = label;
  root.dataset.status = status.toLowerCase();
}

function logAction(label, detail) {
  const feed = ensureOverlay().querySelector('.chrome-controller-feed');
  const item = document.createElement('li');
  item.innerHTML = `<span>${label}</span>${detail ? `<b>${truncate(detail, 42)}</b>` : ''}`;
  feed.prepend(item);
  while (feed.children.length > MAX_FEED_ITEMS) {
    feed.lastElementChild.remove();
  }
}

function updateTab(tab) {
  const tabEl = ensureOverlay().querySelector('.chrome-controller-tab');
  if (!tab) {
    tabEl.textContent = 'No controlled tab';
    return;
  }
  const title = tab.title || tab.url || `Tab ${tab.tabId}`;
  tabEl.textContent = `Tab ${tab.tabId}: ${truncate(title, 54)}`;
  tabEl.title = tab.url || title;
}

function setTitleMarker(enabled) {
  if (enabled) {
    if (state.originalTitle == null) {
      state.originalTitle = document.title.startsWith(TITLE_PREFIX)
        ? document.title.slice(TITLE_PREFIX.length)
        : document.title;
    }
    if (!document.title.startsWith(TITLE_PREFIX)) {
      document.title = `${TITLE_PREFIX}${document.title}`;
    }
    return;
  }

  if (state.originalTitle != null) {
    document.title = state.originalTitle;
    state.originalTitle = null;
  } else if (document.title.startsWith(TITLE_PREFIX)) {
    document.title = document.title.slice(TITLE_PREFIX.length);
  }
}

function getFaviconLinks() {
  return Array.from(document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'));
}

function getBestFaviconHref() {
  const links = getFaviconLinks();
  const preferred = links.find((link) => link.rel === 'icon' && link.href)
    || links.find((link) => link.href);
  return preferred?.href || '/favicon.ico';
}

function makeCompositeRobotFaviconHref(originalHref) {
  const safeOriginalHref = String(originalHref || '/favicon.ico')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="10" fill="#07111d"/>
  <image href="${safeOriginalHref}" x="2" y="2" width="60" height="60" preserveAspectRatio="xMidYMid meet"/>
  <circle cx="46" cy="46" r="17" fill="#07111d" stroke="#70e9ff" stroke-width="4"/>
  <rect x="35" y="39" width="22" height="16" rx="5" fill="#70e9ff"/>
  <path d="M46 39v-6" stroke="#70e9ff" stroke-width="3" stroke-linecap="round"/>
  <circle cx="46" cy="31" r="3" fill="#ffda6a"/>
  <circle cx="41" cy="46" r="2.2" fill="#07111d"/>
  <circle cx="51" cy="46" r="2.2" fill="#07111d"/>
  <path d="M42 52h8" stroke="#07111d" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function setRobotFavicon(enabled) {
  if (enabled) {
    if (!state.originalFavicons) {
      state.originalFavicons = getFaviconLinks().map((link) => ({
        rel: link.getAttribute('rel'),
        href: link.getAttribute('href'),
        type: link.getAttribute('type'),
        sizes: link.getAttribute('sizes'),
      }));
    }

    getFaviconLinks().forEach((link) => {
      if (link.id !== ROBOT_FAVICON_ID) {
        link.dataset.chromeControllerHiddenFavicon = 'true';
        link.disabled = true;
      }
    });

    let robotLink = document.getElementById(ROBOT_FAVICON_ID);
    if (!robotLink) {
      robotLink = document.createElement('link');
      robotLink.id = ROBOT_FAVICON_ID;
      robotLink.rel = 'icon';
      document.head.appendChild(robotLink);
    }
    robotLink.type = 'image/svg+xml';
    robotLink.href = makeCompositeRobotFaviconHref(getBestFaviconHref());
    return;
  }

  const robotLink = document.getElementById(ROBOT_FAVICON_ID);
  if (robotLink) robotLink.remove();

  document.querySelectorAll('link[data-chrome-controller-hidden-favicon="true"]').forEach((link) => {
    link.disabled = false;
    delete link.dataset.chromeControllerHiddenFavicon;
  });

  if (state.originalFavicons && getFaviconLinks().length === 0) {
    state.originalFavicons.forEach((item) => {
      const link = document.createElement('link');
      if (item.rel) link.setAttribute('rel', item.rel);
      if (item.href) link.setAttribute('href', item.href);
      if (item.type) link.setAttribute('type', item.type);
      if (item.sizes) link.setAttribute('sizes', item.sizes);
      document.head.appendChild(link);
    });
  }
  state.originalFavicons = null;
}

function updateCursor(x, y, status = 'Moving') {
  if (typeof x !== 'number' || typeof y !== 'number') return;

  const root = ensureOverlay();
  const cursor = root.querySelector('.chrome-controller-cursor');
  const coords = root.querySelector('.chrome-controller-coords');
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);

  state.cursor = { x: roundedX, y: roundedY };
  cursor.style.transform = `translate3d(${roundedX}px, ${roundedY}px, 0)`;
  coords.textContent = `x ${roundedX}, y ${roundedY}`;
  setStatus(status);
  setRootClass('chrome-controller-has-cursor', true);
  spawnTrail(roundedX, roundedY);
}

function spawnTrail(x, y) {
  const dot = document.createElement('span');
  dot.className = 'chrome-controller-trail';
  dot.style.left = `${x}px`;
  dot.style.top = `${y}px`;
  ensureOverlay().appendChild(dot);
  setTimeout(() => dot.remove(), 420);
}

function spawnRipple(x, y, tone = 'click') {
  if (typeof x !== 'number' || typeof y !== 'number') return;
  const ripple = document.createElement('div');
  ripple.className = `chrome-controller-ripple chrome-controller-ripple-${tone}`;
  ripple.style.left = `${Math.round(x)}px`;
  ripple.style.top = `${Math.round(y)}px`;
  ensureOverlay().appendChild(ripple);
  setTimeout(() => ripple.remove(), 720);
}

function flashSelectedTab() {
  const root = ensureOverlay();
  root.classList.remove('chrome-controller-flash');
  requestAnimationFrame(() => root.classList.add('chrome-controller-flash'));
}

function createTypingBurst(text) {
  const root = ensureOverlay();
  const typing = root.querySelector('.chrome-controller-typing');
  const source = String(text || '').replace(/\s+/g, ' ');
  const visibleText = source || 'key event';
  const maxChars = 80;
  let index = 0;

  clearInterval(state.typingTimer);
  typing.hidden = false;
  typing.textContent = '';
  setStatus('Typing', visibleText);

  state.typingTimer = setInterval(() => {
    const chunkSize = Math.max(1, Math.min(5, Math.ceil((visibleText.length - index) / 8)));
    const next = visibleText.slice(index, index + chunkSize);
    index += chunkSize;
    typing.textContent = truncate(visibleText.slice(0, index), maxChars);
    spawnKeyBurst(next);

    if (index >= visibleText.length) {
      clearInterval(state.typingTimer);
      state.typingTimer = setTimeout(() => {
        typing.hidden = true;
        typing.textContent = '';
        setStatus('Selected');
      }, 700);
    }
  }, 18);
}

function spawnKeyBurst(text) {
  if (!text) return;
  const root = ensureOverlay();
  const burst = document.createElement('span');
  burst.className = 'chrome-controller-keyburst';
  burst.textContent = truncate(text, 6);

  const x = state.cursor.x ?? Math.min(window.innerWidth - 84, 92);
  const y = state.cursor.y ?? 96;
  burst.style.left = `${x + 14 + Math.random() * 18}px`;
  burst.style.top = `${y - 24 - Math.random() * 16}px`;
  root.appendChild(burst);
  setTimeout(() => burst.remove(), 680);
}

function playTypingSound() {
  if (state.audioMuted) return;
  const now = performance.now();
  if (now - state.lastSoundAt < 26) return;
  state.lastSoundAt = now;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    if (!state.audioContext) {
      state.audioContext = new AudioContextClass();
      if (state.audioContext.state === 'suspended') {
        state.audioContext.resume().catch(() => {});
      }
    }
    const context = state.audioContext;

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.value = 980 + Math.random() * 320;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.035, context.currentTime + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.038);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.045);
  } catch (err) {
    // Audio may be blocked until the page receives a user gesture.
  }
}

function setAudioMuted(muted) {
  state.audioMuted = muted;
  const root = ensureOverlay();
  const btn = root.querySelector('.chrome-controller-audio-btn');
  if (!btn) return;
  btn.textContent = muted ? '🔇' : '🔊';
  btn.setAttribute('aria-label', muted ? 'Unmute typing sounds' : 'Mute typing sounds');
  btn.setAttribute('title', muted ? 'Unmute typing sounds' : 'Mute typing sounds');

  if (!muted && !state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      state.audioContext = new AudioContextClass();
      if (state.audioContext.state === 'suspended') {
        state.audioContext.resume().catch(() => {});
      }
    }
  }
}

function setOverlayHidden(hidden) {
  state.overlayHidden = hidden;
  const root = document.getElementById(ROOT_ID);
  if (root) {
    root.style.display = hidden ? 'none' : '';
  }
}

function spawnSparkle() {
  if (!state.selected) return;
  const root = ensureOverlay();
  const layer = root.querySelector('.chrome-controller-sparkles');
  if (!layer) return;

  const sparkle = document.createElement('span');
  const width = 2 + Math.round(Math.random() * 4);
  const height = Math.max(1, width - Math.round(Math.random() * 2));
  sparkle.className = 'chrome-controller-sparkle';
  sparkle.style.left = `${6 + Math.random() * 88}vw`;
  sparkle.style.top = `${8 + Math.random() * 82}vh`;
  sparkle.style.width = `${width}px`;
  sparkle.style.height = `${height}px`;
  sparkle.style.setProperty('--cc-dust-x', `${Math.round((Math.random() - 0.5) * 60)}px`);
  sparkle.style.setProperty('--cc-dust-y', `${Math.round((Math.random() - 0.5) * 60)}px`);
  sparkle.style.setProperty('--cc-dust-rx', Math.random().toFixed(2));
  sparkle.style.setProperty('--cc-dust-ry', Math.random().toFixed(2));
  sparkle.style.setProperty('--cc-dust-rz', Math.random().toFixed(2));
  sparkle.style.setProperty('--cc-dust-rot', `${Math.round((Math.random() - 0.5) * 720)}deg`);
  sparkle.style.animationDelay = `${Math.random() * 220}ms`;
  layer.appendChild(sparkle);
  setTimeout(() => sparkle.remove(), 4400);
}

function setSparkles(enabled) {
  if (enabled) {
    if (state.sparkleTimer) return;
    state.sparkleTimer = setInterval(spawnSparkle, 760);
    setTimeout(spawnSparkle, 260);
    setTimeout(spawnSparkle, 920);
    setTimeout(spawnSparkle, 1600);
    return;
  }

  if (state.sparkleTimer) {
    clearInterval(state.sparkleTimer);
    state.sparkleTimer = null;
  }
  const layer = document.querySelector(`#${ROOT_ID} .chrome-controller-sparkles`);
  if (layer) layer.replaceChildren();
}

function handleControllerState(request) {
  state.selected = Boolean(request.selected);
  setRootClass('chrome-controller-selected', state.selected);
  setTitleMarker(state.selected);
  setRobotFavicon(state.selected);
  setSparkles(state.selected);

  if (state.selected) {
    updateTab(request.tab);
    setStatus(request.status === 'released' ? 'Released' : 'Selected', request.reason);
    logAction('Selected tab', request.reason);
    flashSelectedTab();
  } else {
    setStatus('Released', request.reason);
    logAction('Released tab', request.reason);
    setTimeout(() => {
      if (!state.selected) {
        setRootClass('chrome-controller-has-cursor', false);
      }
    }, 900);
  }
}

function handleVisualAction(request) {
  const type = request.type || 'action';

  if (type === 'move') {
    updateCursor(request.x, request.y, 'Moving');
    logAction('Move', `x ${Math.round(request.x)}, y ${Math.round(request.y)}`);
    return;
  }

  if (type === 'press') {
    updateCursor(request.x, request.y, 'Mouse down');
    setRootClass('chrome-controller-pressing', true);
    spawnRipple(request.x, request.y, 'press');
    logAction('Mouse down', request.button || request.detail);
    return;
  }

  if (type === 'release' || type === 'click') {
    updateCursor(request.x, request.y, type === 'click' ? 'Click' : 'Mouse up');
    setRootClass('chrome-controller-pressing', false);
    spawnRipple(request.x, request.y, 'click');
    logAction(type === 'click' ? 'Click' : 'Mouse up', request.button || request.detail);
    return;
  }

  if (type === 'typing' || type === 'insertText') {
    createTypingBurst(request.detail || '');
    if (request.sound !== false) {
      playTypingSound();
    }
    logAction(type === 'insertText' ? 'Insert text' : 'Type', request.detail);
    return;
  }

  if (type === 'highlight') {
    flashSelectedTab();
    setStatus(request.active === false ? 'Inactive' : 'Highlighted');
    logAction('Highlight');
    return;
  }

  setStatus('Action', request.detail || type);
  logAction('Action', request.detail || type);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'setControllerState') {
    handleControllerState(request);
    sendResponse({ success: true });
    return;
  }

  if (request.action === 'visualizeAction') {
    handleVisualAction(request);
    sendResponse({ success: true });
    return;
  }

  // Backwards-compatible handlers for existing callers.
  if (request.action === 'visualizeMove') {
    handleVisualAction({ type: 'move', x: request.x, y: request.y });
    sendResponse({ success: true });
    return;
  }

  if (request.action === 'visualizeClick') {
    handleVisualAction({ type: 'click', x: request.x, y: request.y });
    sendResponse({ success: true });
    return;
  }

  if (request.action === 'highlightTab') {
    handleVisualAction({ type: 'highlight', active: request.active });
    sendResponse({ success: true });
  }
});
