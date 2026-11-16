import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.join(repoRoot, 'Chrome Extension');

const CHROME_EXECUTABLES = [
  process.env['CHROME_PATH'],
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter((p): p is string => Boolean(p));

async function launchBrowser(): Promise<Browser> {
  for (const executablePath of CHROME_EXECUTABLES) {
    try {
      await fs.access(executablePath);
      return await chromium.launch({ executablePath, headless: true });
    } catch {
      // Try next
    }
  }
  return await chromium.launch({ channel: 'chrome', headless: true });
}

test('browser: "hide overlay" checkbox and Alt+O completely remove HUD and overlay to unblock website controls', async () => {
  const css = await fs.readFile(path.join(extensionDir, 'content.css'), 'utf8');
  const js = await fs.readFile(path.join(extensionDir, 'content.js'), 'utf8');

  // Start local HTTP server to provide valid origin for sessionStorage and DOM controls
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <style>
    /* Website menu button in standard top-right corner */
    #website-menu-btn {
      position: fixed;
      top: 18px;
      right: 18px;
      z-index: 1000;
      padding: 8px 14px;
    }
  </style>
</head>
<body>
  <button id="website-menu-btn">Account Menu</button>
</body>
</html>`);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}/`;

  try {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.goto(url);

      const setupPage = async () => {
        await page.addScriptTag({
          content: `
            window.__chromeMessageListeners = [];
            window.__sentRuntimeMessages = [];
            window.chrome = {
              runtime: {
                onMessage: {
                  addListener: (fn) => window.__chromeMessageListeners.push(fn),
                },
                sendMessage: async (msg) => {
                  window.__sentRuntimeMessages.push(msg);
                  return { success: true };
                },
              },
            };
          `,
        });
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: js });
      };

      await setupPage();

      const dispatchMessage = async (msg: any) => {
        return await page.evaluate((message) => {
          let lastRes: any = null;
          for (const listener of (window as any).__chromeMessageListeners) {
            listener(message, {}, (res: any) => {
              lastRes = res;
            });
          }
          return lastRes;
        }, msg);
      };

      // 1. Initial tab targeting
      await dispatchMessage({
        action: 'setControllerState',
        selected: true,
        status: 'targeted',
        tab: { tabId: 1, title: 'Test Tab' },
      });

      // Initially, the overlay root and HUD are mounted
      const initialRoot = await page.evaluate(() => {
        const root = document.getElementById('chrome-controller-overlay-root');
        const hud = document.querySelector('.chrome-controller-hud');
        return {
          rootDisplay: root ? window.getComputedStyle(root).display : null,
          hudDisplay: hud ? window.getComputedStyle(hud).display : null,
        };
      });
      assert.equal(initialRoot.rootDisplay, 'block');
      assert.equal(initialRoot.hudDisplay, 'block');

      // 2. Click "Hide overlay" checkbox
      await page.hover('.chrome-controller-hud');
      const hideToggle = await page.$('.chrome-controller-hide-toggle');
      assert.ok(hideToggle, 'hide overlay checkbox must exist');
      await hideToggle.click();

      // Verify that when hidden, the entire overlay root (including HUD) is completely display: none
      // so it never blocks common menu controls on websites
      const hiddenState = await page.evaluate(() => {
        const root = document.getElementById('chrome-controller-overlay-root');
        const hud = document.querySelector('.chrome-controller-hud');
        const frame = document.querySelector('.chrome-controller-frame');
        const websiteMenu = document.getElementById('website-menu-btn');
        const elemAtPoint = document.elementFromPoint(
          websiteMenu!.getBoundingClientRect().left + 5,
          websiteMenu!.getBoundingClientRect().top + 5
        );
        return {
          rootDisplay: root ? window.getComputedStyle(root).display : null,
          hudDisplay: hud ? window.getComputedStyle(hud).display : null,
          frameDisplay: frame ? window.getComputedStyle(frame).display : null,
          rootHasHiddenClass: root ? root.classList.contains('chrome-controller-hidden-overlay') : false,
          topElementAtWebsiteMenu: elemAtPoint ? elemAtPoint.id : null,
        };
      });

      assert.equal(hiddenState.rootHasHiddenClass, true, 'root has hidden class');
      assert.equal(hiddenState.rootDisplay, 'none', 'root must be display: none when hidden');
      assert.equal(hiddenState.hudDisplay, 'none', 'HUD must be display: none so it does not block website controls');
      assert.equal(hiddenState.frameDisplay, 'none', 'frame must be display: none');
      // Decisive check: element at top-right website menu coordinate is the website menu button itself!
      assert.equal(
        hiddenState.topElementAtWebsiteMenu,
        'website-menu-btn',
        'website menu button must receive pointer events without being blocked by overlay'
      );

      // 3. Test unhiding via Alt+O keyboard shortcut
      await page.keyboard.press('Alt+KeyO');

      const unhiddenViaHotkey = await page.evaluate(() => {
        const root = document.getElementById('chrome-controller-overlay-root');
        const hud = document.querySelector('.chrome-controller-hud');
        const toggle = document.querySelector<HTMLInputElement>('.chrome-controller-hide-toggle');
        return {
          rootDisplay: root ? window.getComputedStyle(root).display : null,
          hudDisplay: hud ? window.getComputedStyle(hud).display : null,
          toggleChecked: toggle ? toggle.checked : false,
        };
      });

      assert.equal(unhiddenViaHotkey.rootDisplay, 'block', 'Alt+O restores overlay root');
      assert.equal(unhiddenViaHotkey.hudDisplay, 'block', 'Alt+O restores HUD');
      assert.equal(unhiddenViaHotkey.toggleChecked, false, 'toggle is unchecked after Alt+O unhide');

      // 4. Test re-hiding via Alt+O keyboard shortcut
      await page.keyboard.press('Alt+KeyO');

      const rehiddenViaHotkey = await page.evaluate(() => {
        const root = document.getElementById('chrome-controller-overlay-root');
        return root ? window.getComputedStyle(root).display : null;
      });
      assert.equal(rehiddenViaHotkey, 'none', 'Alt+O re-hides overlay');

      // Unhide again for drag testing
      await page.keyboard.press('Alt+KeyO');

      // 5. Test dragging HUD to move it away from top-right corner
      await page.hover('.chrome-controller-hud');
      await page.waitForFunction(() => {
        const hud = document.querySelector('.chrome-controller-hud');
        return hud ? hud.getBoundingClientRect().width >= 300 : false;
      });
      const statusEl = await page.$('.chrome-controller-status');
      assert.ok(statusEl);
      const initialHudPos = await page.evaluate(() => {
        const hud = document.querySelector('.chrome-controller-hud');
        const rect = hud!.getBoundingClientRect();
        return { left: rect.left, top: rect.top };
      });

      // Perform drag gesture on the status label inside statusRow (expanded, clear of audio button)
      const statusBox = await statusEl.boundingBox();
      assert.ok(statusBox);
      await page.mouse.move(statusBox.x + statusBox.width / 2, statusBox.y + statusBox.height / 2);
      await page.mouse.down();

      // Verify dragging state locks expanded HUD dimensions without CSS transition jitter
      const duringDrag = await page.evaluate(() => {
        const root = document.getElementById('chrome-controller-overlay-root');
        const hud = document.querySelector('.chrome-controller-hud');
        return {
          hasDraggingClass: root ? root.classList.contains('chrome-controller-dragging') : false,
          hudTransition: hud ? window.getComputedStyle(hud).transitionProperty : null,
        };
      });
      assert.equal(duringDrag.hasDraggingClass, true, 'root must have chrome-controller-dragging class during drag');
      assert.equal(duringDrag.hudTransition, 'none', 'HUD CSS transitions must be disabled during drag');

      await page.mouse.move(100, 300);
      await page.mouse.up();

      const draggedHudPos = await page.evaluate(() => {
        const root = document.getElementById('chrome-controller-overlay-root');
        const hud = document.querySelector('.chrome-controller-hud');
        const rect = hud!.getBoundingClientRect();
        const stored = sessionStorage.getItem('chrome_controller_hud_pos');
        return {
          left: rect.left,
          top: rect.top,
          stored,
          hasDraggingClass: root ? root.classList.contains('chrome-controller-dragging') : true,
        };
      });

      assert.equal(draggedHudPos.hasDraggingClass, false, 'chrome-controller-dragging class must be removed on mouseup');
      assert.notEqual(draggedHudPos.left, initialHudPos.left, 'HUD position changed after drag');
      assert.ok(draggedHudPos.left < 200, `HUD moved to target x region (got left=${draggedHudPos.left})`);
      assert.ok(draggedHudPos.stored, 'HUD position stored in sessionStorage');

      // 6. Test logAction HTML escaping (no DOM XSS when selector/text contains HTML)
      await dispatchMessage({
        action: 'visualizeAction',
        type: 'insertText',
        detail: '<img id="xss-probe" src=x onerror="window.__xss=true">',
        sound: false,
      });
      const xssCheck = await page.evaluate(() => {
        const probe = document.getElementById('xss-probe');
        const detailEl = document.querySelector('.chrome-controller-feed li b');
        return {
          probeExists: Boolean(probe),
          xssTriggered: Boolean((window as any).__xss),
          detailText: detailEl ? detailEl.textContent : null,
        };
      });
      assert.equal(xssCheck.probeExists, false, 'HTML inside logAction detail must not be parsed as DOM nodes');
      assert.equal(xssCheck.xssTriggered, false, 'XSS payload must not execute');
      assert.ok(xssCheck.detailText?.startsWith('<img id="xss-probe"'), 'literal text must be rendered');

      // 7. Test console.error formatting for Error instances, circular references, and BigInt
      await page.evaluate(() => {
        console.error(new Error('synthetic-error-msg'));
        const circular: Record<string, unknown> = { label: 'circ' };
        circular.self = circular;
        console.error(circular);
        console.error({ count: 42n });
      });
      const pageErrorsRes = await dispatchMessage({ action: 'getPageErrors' });
      assert.equal(pageErrorsRes.success, true);
      const errorMessages = (pageErrorsRes.errors as Array<{ message: string; stack: string | null }>).map((e) => e.message);
      assert.ok(
        errorMessages.some((m) => m.includes('synthetic-error-msg')),
        `Error instance message must be captured instead of "{}"; got: ${JSON.stringify(errorMessages)}`
      );
      assert.ok(
        errorMessages.some((m) => m.includes('[object Object]')),
        `Circular console.error must be captured without throwing; got: ${JSON.stringify(errorMessages)}`
      );
      assert.ok(
        errorMessages.some((m) => m.includes('"42n"')),
        `BigInt console.error must be formatted via replacer; got: ${JSON.stringify(errorMessages)}`
      );
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
