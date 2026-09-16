const ROOT_ID = 'chrome-controller-overlay-root';
const BADGE_CONTAINER_ID = 'chrome-controller-badges-container';
const MAX_FEED_ITEMS = 5;
const TITLE_PREFIX = '🤖 ';
const ROBOT_FAVICON_ID = 'chrome-controller-robot-favicon';
const STORAGE_KEY_HIDE_OVERLAY = 'chrome_controller_hide_overlay';
const STORAGE_KEY_HUD_POS = 'chrome_controller_hud_pos';

function getStoredOverlayHidden() {
  try {
    return sessionStorage.getItem(STORAGE_KEY_HIDE_OVERLAY) === 'true';
  } catch {
    return false;
  }
}

function setStoredOverlayHidden(hidden) {
  try {
    if (hidden) {
      sessionStorage.setItem(STORAGE_KEY_HIDE_OVERLAY, 'true');
    } else {
      sessionStorage.removeItem(STORAGE_KEY_HIDE_OVERLAY);
    }
  } catch {
    // Ignore storage errors on restricted origins
  }
}

function getStoredHudPosition() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY_HUD_POS);
    if (raw) return JSON.parse(raw);
  } catch {
    // Ignore storage errors
  }
  return null;
}

function setStoredHudPosition(left, top) {
  try {
    if (left && top) {
      sessionStorage.setItem(STORAGE_KEY_HUD_POS, JSON.stringify({ left, top }));
    }
  } catch {
    // Ignore storage errors
  }
}

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
  overlayHidden: getStoredOverlayHidden(),
};

// ── Continuous Error Logging Ring Buffer ────────────────────────────────────
const capturedErrors = [];
const MAX_CAPTURED_ERRORS = 50;

function recordError(type, message, source, lineno, colno, stack) {
  capturedErrors.push({
    type,
    message: String(message || ''),
    source: source || location.href,
    lineno: lineno || 0,
    colno: colno || 0,
    stack: stack ? String(stack).slice(0, 1000) : null,
    timestamp: Date.now(),
  });
  if (capturedErrors.length > MAX_CAPTURED_ERRORS) {
    capturedErrors.shift();
  }
}

window.addEventListener('error', (event) => {
  recordError('error', event.message, event.filename, event.lineno, event.colno, event.error?.stack);
});

window.addEventListener('unhandledrejection', (event) => {
  recordError('unhandledrejection', event.reason?.message || event.reason, location.href, 0, 0, event.reason?.stack);
});

// Patch console.error
const origConsoleError = console.error;
console.error = function (...args) {
  recordError('console.error', args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
  origConsoleError.apply(console, args);
};

// ── Helper Utilities ────────────────────────────────────────────────────────
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
        <label class="chrome-controller-settings-item" title="Toggle overlay visibility (Alt+O)">
          <input type="checkbox" class="chrome-controller-hide-toggle" />
          <span>Hide overlay</span>
          <kbd class="chrome-controller-kbd">Alt+O</kbd>
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

  const storedPos = getStoredHudPosition();
  if (storedPos && storedPos.left && storedPos.top) {
    const hudEl = root.querySelector('.chrome-controller-hud');
    if (hudEl) {
      hudEl.style.left = storedPos.left;
      hudEl.style.top = storedPos.top;
      hudEl.style.right = 'auto';
    }
  }

  if (state.overlayHidden) {
    root.classList.add('chrome-controller-hidden-overlay');
  }
  wireOverlayControls(root);
  return root;
}

function wireOverlayControls(root) {
  if (root.dataset.chromeControllerControlsWired === 'true') return;
  root.dataset.chromeControllerControlsWired = 'true';

  const hud = root.querySelector('.chrome-controller-hud');
  if (hud) {
    hud.addEventListener('click', (e) => e.stopPropagation());
    hud.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  const statusRow = root.querySelector('.chrome-controller-status-row');
  if (statusRow && hud) {
    statusRow.title = 'Drag to reposition HUD';
    statusRow.addEventListener('mousedown', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      const rect = hud.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      statusRow.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();

      const onMouseMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        const maxLeft = Math.max(0, window.innerWidth - rect.width);
        const maxTop = Math.max(0, window.innerHeight - rect.height);
        const newLeft = Math.max(0, Math.min(maxLeft, startLeft + dx));
        const newTop = Math.max(0, Math.min(maxTop, startTop + dy));
        hud.style.left = `${Math.round(newLeft)}px`;
        hud.style.top = `${Math.round(newTop)}px`;
        hud.style.right = 'auto';
        hud.style.bottom = 'auto';
      };

      const onMouseUp = () => {
        statusRow.style.cursor = 'grab';
        window.removeEventListener('mousemove', onMouseMove, true);
        window.removeEventListener('mouseup', onMouseUp, true);
        setStoredHudPosition(hud.style.left, hud.style.top);
      };

      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('mouseup', onMouseUp, true);
    });
  }

  const audioBtn = root.querySelector('.chrome-controller-audio-btn');
  if (audioBtn) {
    audioBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setAudioMuted(!state.audioMuted);
    });
  }

  const hideToggle = root.querySelector('.chrome-controller-hide-toggle');
  if (hideToggle) {
    hideToggle.checked = Boolean(state.overlayHidden);
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

function updateCursor(x, y, label) {
  if (x == null || y == null) return;
  state.cursor = { x, y };

  const root = ensureOverlay();
  setRootClass('chrome-controller-has-cursor', true);
  const cursor = root.querySelector('.chrome-controller-cursor');
  cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;

  const coords = root.querySelector('.chrome-controller-coords');
  coords.textContent = `x ${Math.round(x)}, y ${Math.round(y)}`;
  if (label) setStatus(label);
}

function spawnRipple(x, y, kind = 'click') {
  if (state.overlayHidden || x == null || y == null) return;
  const root = ensureOverlay();
  const ripple = document.createElement('div');
  ripple.className = `chrome-controller-ripple chrome-controller-ripple-${kind}`;
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  root.appendChild(ripple);
  setTimeout(() => ripple.remove(), 700);
}

function setAudioMuted(muted) {
  state.audioMuted = muted;
  const btn = ensureOverlay().querySelector('.chrome-controller-audio-btn');
  if (btn) {
    btn.textContent = muted ? '🔇' : '🔊';
    btn.setAttribute('aria-label', muted ? 'Unmute typing sounds' : 'Mute typing sounds');
  }
}

function setOverlayHidden(hidden) {
  state.overlayHidden = Boolean(hidden);
  setStoredOverlayHidden(state.overlayHidden);
  setRootClass('chrome-controller-hidden-overlay', state.overlayHidden);

  const root = document.getElementById(ROOT_ID);
  if (root) {
    const toggle = root.querySelector('.chrome-controller-hide-toggle');
    if (toggle && toggle.checked !== state.overlayHidden) {
      toggle.checked = state.overlayHidden;
    }
  }

  const badges = document.getElementById(BADGE_CONTAINER_ID);
  if (badges) {
    badges.style.display = state.overlayHidden ? 'none' : '';
  }

  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ action: 'setOverlayHidden', hidden: state.overlayHidden }).catch(() => {});
    }
  } catch {}
}

function flashSelectedTab() {
  const root = ensureOverlay();
  root.classList.remove('chrome-controller-flash');
  void root.offsetWidth;
  root.classList.add('chrome-controller-flash');
}

// ── Element Snapshotting & Ref Tagging ─────────────────────────────────────

function snapshotElements(options = {}) {
  const showOverlay = options.showOverlay !== false && !state.overlayHidden;

  // Clear existing badge overlay container if present
  let badgeContainer = document.getElementById(BADGE_CONTAINER_ID);
  if (badgeContainer) badgeContainer.remove();

  if (showOverlay) {
    badgeContainer = document.createElement('div');
    badgeContainer.id = BADGE_CONTAINER_ID;
    badgeContainer.style.position = 'absolute';
    badgeContainer.style.top = '0';
    badgeContainer.style.left = '0';
    badgeContainer.style.width = '100%';
    badgeContainer.style.height = '100%';
    badgeContainer.style.pointerEvents = 'none';
    badgeContainer.style.zIndex = '2147483640';
    const mount = document.body || document.documentElement;
    mount.appendChild(badgeContainer);
  }

  const selectors = [
    'button', 'a[href]', 'input', 'textarea', 'select', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="menuitem"]',
    '[role="tab"]', '[role="option"]', '[role="switch"]', '[role="combobox"]', '[role="treeitem"]',
    '[onclick]', '[contenteditable="true"]'
  ].join(',');

  const rawElements = Array.from(document.querySelectorAll(selectors));
  const items = [];
  let idCounter = 1;

  for (const el of rawElements) {
    if (el.closest(`#${ROOT_ID}`) || el.closest(`#${BADGE_CONTAINER_ID}`)) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || el.offsetParent === null) continue;

    const id = idCounter++;
    el.setAttribute('data-cc-id', String(id));

    const tag = el.tagName.toUpperCase();
    const type = el.getAttribute('type') || '';
    const text = (el.innerText || el.ariaLabel || el.placeholder || el.value || el.title || '').trim().slice(0, 100);

    let selector = tag.toLowerCase();
    if (el.id) {
      selector += `#${CSS.escape(el.id)}`;
    } else if (el.className && typeof el.className === 'string') {
      const cls = el.className.split(/\s+/).filter(Boolean)[0];
      if (cls) selector += `.${CSS.escape(cls)}`;
    }

    items.push({
      id,
      tag,
      type,
      text,
      selector,
      bbox: {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });

    if (showOverlay && badgeContainer) {
      const badge = document.createElement('div');
      badge.textContent = String(id);
      badge.style.position = 'absolute';
      badge.style.left = `${rect.left + window.scrollX}px`;
      badge.style.top = `${rect.top + window.scrollY}px`;
      badge.style.background = '#06b6d4';
      badge.style.color = '#0f172a';
      badge.style.fontSize = '11px';
      badge.style.fontWeight = 'bold';
      badge.style.padding = '1px 5px';
      badge.style.borderRadius = '4px';
      badge.style.boxShadow = '0 2px 4px rgba(0,0,0,0.4)';
      badge.style.pointerEvents = 'none';
      badgeContainer.appendChild(badge);
    }
  }

  logAction('Snapshot', `Tagged ${items.length} interactive elements`);
  return { elements: items, count: items.length };
}

function findElement(selector, elementId) {
  if (elementId != null) {
    const el = document.querySelector(`[data-cc-id="${elementId}"]`);
    if (el) return el;
  }
  if (selector) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  throw new Error(`Element not found for selector="${selector}" elementId="${elementId}"`);
}

function clickSelector(options = {}) {
  const el = findElement(options.selector, options.elementId);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  updateCursor(cx, cy, 'Clicking');
  spawnRipple(cx, cy, 'click');

  el.focus();
  el.click();
  logAction('Click selector', options.selector || `[${options.elementId}]`);
  return { success: true, text: (el.innerText || el.value || '').trim() };
}

function fillSelector(options = {}) {
  const el = findElement(options.selector, options.elementId);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const rect = el.getBoundingClientRect();

  updateCursor(rect.left + 10, rect.top + rect.height / 2, 'Filling text');

  el.focus();
  const text = options.text || '';
  if ('value' in el) {
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, text);
    } else {
      el.value = text;
    }
  } else {
    el.textContent = text;
  }

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  logAction('Fill selector', text);
  return { success: true, text };
}

function selectOption(options = {}) {
  const el = findElement(options.selector, options.elementId);
  if (el.tagName !== 'SELECT') {
    throw new Error(`Target element is not a <select>, got <${el.tagName}>`);
  }
  el.focus();
  el.value = options.value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  logAction('Select option', options.value);
  return { success: true, value: options.value };
}

// ── Message Listener ────────────────────────────────────────────────────────

function handleControllerState(request) {
  if (typeof request.overlayHidden === 'boolean') {
    setOverlayHidden(request.overlayHidden);
  }
  state.selected = Boolean(request.selected);
  setRootClass('chrome-controller-selected', state.selected);
  setTitleMarker(state.selected);

  if (state.selected) {
    updateTab(request.tab);
    setStatus(request.status === 'released' ? 'Released' : 'Selected', request.reason);
    logAction('Selected tab', request.reason);
    flashSelectedTab();
  } else {
    setStatus('Released', request.reason);
    logAction('Released tab', request.reason);
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
    if (request.sound !== false) {
      setAudioMuted(false);
    }
    logAction(type === 'insertText' ? 'Insert text' : 'Type', request.detail);
    return;
  }

  setStatus('Action', request.detail || type);
  logAction('Action', request.detail || type);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  try {
    if (request.action === 'setControllerState') {
      handleControllerState(request);
      sendResponse({ success: true });
    } else if (request.action === 'visualizeAction') {
      handleVisualAction(request);
      sendResponse({ success: true });
    } else if (request.action === 'snapshotElements') {
      const res = snapshotElements(request);
      sendResponse({ success: true, ...res });
    } else if (request.action === 'clickSelector') {
      const res = clickSelector(request);
      sendResponse({ success: true, ...res });
    } else if (request.action === 'fillSelector') {
      const res = fillSelector(request);
      sendResponse({ success: true, ...res });
    } else if (request.action === 'selectOption') {
      const res = selectOption(request);
      sendResponse({ success: true, ...res });
    } else if (request.action === 'getPageErrors') {
      sendResponse({ success: true, errors: capturedErrors, count: capturedErrors.length });
    } else if (request.action === 'setOverlayHidden') {
      setOverlayHidden(Boolean(request.hidden));
      sendResponse({ success: true, hidden: state.overlayHidden });
    } else if (request.action === 'getOverlayState') {
      sendResponse({ success: true, overlayHidden: state.overlayHidden, selected: state.selected });
    } else {
      sendResponse({ success: false, error: `Unknown content action: ${request.action}` });
    }
  } catch (err) {
    sendResponse({ success: false, error: err.toString() });
  }
  return true;
});

// ── Global Keyboard Shortcuts ───────────────────────────────────────────────

let shortcutsWired = false;
function wireKeyboardShortcuts() {
  if (shortcutsWired) return;
  shortcutsWired = true;
  window.addEventListener(
    'keydown',
    (e) => {
      // Alt+O (or Option+O on macOS) toggles overlay visibility
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'o' || e.key === 'O' || e.code === 'KeyO')) {
        e.preventDefault();
        e.stopPropagation();
        setOverlayHidden(!state.overlayHidden);
      }
    },
    true
  );
}

wireKeyboardShortcuts();

