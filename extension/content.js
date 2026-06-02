let cursor = null;

function createCursor() {
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.id = 'chrome-controller-cursor';
    document.body.appendChild(cursor);
  }
  return cursor;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'visualizeMove') {
    const el = createCursor();
    el.style.left = request.x + 'px';
    el.style.top = request.y + 'px';
    sendResponse({ success: true });
  } else if (request.action === 'visualizeClick') {
    const ripple = document.createElement('div');
    ripple.className = 'chrome-controller-ripple';
    ripple.style.left = request.x + 'px';
    ripple.style.top = request.y + 'px';
    document.body.appendChild(ripple);
    
    // Remove after animation
    setTimeout(() => {
      ripple.remove();
    }, 500);
    sendResponse({ success: true });
  } else if (request.action === 'highlightTab') {
    if (request.active) {
      const overlay = document.createElement('div');
      overlay.className = 'chrome-controller-highlight';
      document.body.appendChild(overlay);
      setTimeout(() => {
        overlay.remove();
      }, 500);
    }
    sendResponse({ success: true });
  }
});
