/**
 * Unit tests for the Pi extension (src/index.ts).
 *
 * Tests mock the fetch API to exercise tool execution logic without requiring
 * a live Chrome Controller server.
 *
 * Run: npx tsx --test src/index.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import chromeControllerPiExtension from './index.ts';
import { setEnv, startScriptedChrome } from '../test/scripted-chrome.ts';

const TEST_API_KEY = 'test-key-0123456789abcdef01234567';
const originalRelayUrl = process.env.CHROME_CONTROLLER_URL;
const originalRelayKey = process.env.CHROME_CONTROLLER_API_KEY;
const originalSocket = process.env.CHROME_CONTROLLER_SOCKET;
// These tests drive the relay. Point IPC at a path that cannot exist so a test
// that clears CHROME_CONTROLLER_URL can never reach a real native host.
process.env.CHROME_CONTROLLER_SOCKET = `/nonexistent/chrome-controller-index-test-${process.pid}.sock`;
process.env.CHROME_CONTROLLER_URL = 'http://127.0.0.1:8898';
process.env.CHROME_CONTROLLER_API_KEY = TEST_API_KEY;

test.after(() => {
  if (originalRelayUrl === undefined) delete process.env.CHROME_CONTROLLER_URL;
  else process.env.CHROME_CONTROLLER_URL = originalRelayUrl;
  if (originalRelayKey === undefined) delete process.env.CHROME_CONTROLLER_API_KEY;
  else process.env.CHROME_CONTROLLER_API_KEY = originalRelayKey;
  if (originalSocket === undefined) delete process.env.CHROME_CONTROLLER_SOCKET;
  else process.env.CHROME_CONTROLLER_SOCKET = originalSocket;
});

// Minimal mock Pi runtime
interface MockPI {
  tools: Record<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }): void;
}

function makeMockPi(): MockPI {
  const tools: Record<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }> = {};
  return {
    tools,
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools[tool.name] = tool;
    },
  };
}

// Mock fetch that returns a successful Chrome response
function mockFetch(result: unknown, ok = true) {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ success: ok, result }),
  } as Response);
  return () => { global.fetch = originalFetch; };
}

test('extension registers all expected tools', () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);
  const expected = [
    'chrome_controller_health',
    'chrome_query_tabs',
    'chrome_create_tab',
    'chrome_select_tab',
    'chrome_release_tab',
    'chrome_cleanup_ai_tabs',
    'chrome_mouse',
    'chrome_type_text',
    'chrome_batch',
    'chrome_screenshot',
    'chrome_evaluate',
    'chrome_extract_content',
    'chrome_extract_regions',
    'chrome_console_logs',
    'chrome_click',
    'chrome_fill',
    'chrome_select_option',
    'chrome_snapshot_elements',
    'chrome_get_page_errors',
  ];
  for (const name of expected) {
    assert.ok(name in pi.tools, `Missing tool: ${name}`);
  }
});

test('chrome_controller_health calls /health endpoint', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let calledUrl = '';
  const originalFetch = global.fetch;
  global.fetch = async (url: string | URL | Request) => {
    calledUrl = String(url);
    return {
      ok: true,
      json: async () => ({ success: true, extensionConnected: true }),
    } as Response;
  };

  const result = await pi.tools['chrome_controller_health'].execute('call_1', {}, undefined);
  assert.ok(calledUrl.includes('/health'), `Expected /health in URL, got: ${calledUrl}`);
  assert.ok((result as { content: Array<{ text: string }> }).content[0].text.includes('extensionConnected'));

  global.fetch = originalFetch;
});

test('relay mode rejects non-loopback controller URLs before fetch', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);
  const previous = process.env.CHROME_CONTROLLER_URL;
  process.env.CHROME_CONTROLLER_URL = 'https://attacker.example';
  try {
    await assert.rejects(
      () => pi.tools['chrome_controller_health'].execute('call-remote', {}, undefined),
      /loopback URL/,
    );
  } finally {
    process.env.CHROME_CONTROLLER_URL = previous;
  }
});

test('chrome_query_tabs returns short response by default', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  const restore = mockFetch([
    { id: 1, title: 'Tab 1', url: 'http://example.com', active: true, windowId: 1, width: 800, height: 600, extra: 'data' },
  ]);

  try {
    const resultShort = await pi.tools['chrome_query_tabs'].execute('call_1', {}, undefined) as { content: Array<{ text: string }> };
    const shortData = JSON.parse(resultShort.content[0].text) as { result: Array<Record<string, unknown>> };
    assert.deepEqual(shortData.result[0], { id: 1, title: 'Tab 1', url: 'http://example.com', active: true, windowId: 1 });
    assert.equal(Object.keys(shortData.result[0]).includes('width'), false);

    const resultFull = await pi.tools['chrome_query_tabs'].execute('call_2', { mode: 'full' }, undefined) as { content: Array<{ text: string }> };
    const fullData = JSON.parse(resultFull.content[0].text) as { result: Array<Record<string, unknown>> };
    assert.ok('width' in fullData.result[0]);
    assert.ok('extra' in fullData.result[0]);
  } finally {
    restore();
  }
});

test('chrome_screenshot saves file and returns path', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  const restore = mockFetch({
    success: true,
    data: { data: Buffer.from('mock_image_data').toString('base64') },
    format: 'png',
  });

  try {
    const result = await pi.tools['chrome_screenshot'].execute('call_1', { tabId: 123 }, undefined) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text) as { success: boolean; path: string };
    assert.equal(parsed.success, true);
    assert.ok(parsed.path.startsWith('/tmp/browser_last_screenshot_'), `Unexpected path: ${parsed.path}`);
  } finally {
    restore();
  }
});

test('chrome_evaluate truncates large strings by default', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  const largeString = 'x'.repeat(60000);
  const restore = mockFetch({ result: { type: 'string', value: largeString } });

  try {
    const result = await pi.tools['chrome_evaluate'].execute(
      'call_1',
      { tabId: 123, expression: 'document.body.innerHTML' },
      undefined
    ) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text) as { result: { result: { value: string } } };
    assert.ok(parsed.result.result.value.includes('[TRUNCATED'), 'Expected truncation marker');
    assert.ok(parsed.result.result.value.length < 60000, 'Expected string to be truncated');
  } finally {
    restore();
  }
});

test('chrome_evaluate with untruncated:true returns full string', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  const largeString = 'x'.repeat(60000);
  const restore = mockFetch({ result: { type: 'string', value: largeString } });

  try {
    const result = await pi.tools['chrome_evaluate'].execute(
      'call_1',
      { tabId: 123, expression: 'document.body.innerHTML', untruncated: true },
      undefined
    ) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text) as { result: { result: { value: string } } };
    assert.equal(parsed.result.result.value.length, 60000);
    assert.ok(!parsed.result.result.value.includes('[TRUNCATED'));
  } finally {
    restore();
  }
});

test('chrome_mouse sends debugger batch for click', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true, result: {} }),
    } as Response;
  };

  await pi.tools['chrome_mouse'].execute('call_1', { tabId: 5, type: 'click', x: 100, y: 200 }, undefined);

  const p = sentPayload as { mode: string; actions: Array<{ action: string }> };
  assert.equal(p.mode, 'sequential');
  // ensureDebugger + move + press + release = 4 actions
  assert.equal(p.actions.length, 4);
  assert.equal(p.actions[0].action, 'ensureDebugger');

  global.fetch = originalFetch;
});

test('chrome_batch sends raw actions payload', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true, result: {} }),
    } as Response;
  };

  await pi.tools['chrome_batch'].execute(
    'call_1',
    { mode: 'parallel', actions: [{ action: 'queryTabs' }, { action: 'createTab', url: 'https://example.com' }] },
    undefined
  );

  const p = sentPayload as { action: string; mode: string; actions: unknown[] };
  // The relay treats any body with an `actions` array as a batch, so it never
  // needed `action`; the native host forwards `action` to Chrome verbatim.
  assert.equal(p.action, 'batch');
  assert.equal(p.mode, 'parallel');
  assert.equal(p.actions.length, 2);

  global.fetch = originalFetch;
});

test('chrome_batch over the relay gives an item with work of its own its own wait', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return { ok: true, json: async () => ({ success: true, results: [] }) } as Response;
  };
  try {
    await pi.tools['chrome_batch'].execute(
      'call_1',
      { mode: 'sequential', actions: [{ action: 'getConsoleLogs', tabId: 1, timeoutMs: 300 }, { action: 'queryTabs' }] },
      undefined,
    );
    // The relay waits on each item separately: without its own wait, it would
    // read the 300 ms collection window as the item's wait and time it out.
    const p = sentPayload as { actions: Array<Record<string, unknown>> };
    assert.deepEqual(p.actions, [
      { action: 'getConsoleLogs', tabId: 1, timeoutMs: 300, requestTimeoutMs: 15300 },
      { action: 'queryTabs' },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('chrome_create_tab sends correct payload', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true, result: { tabId: 42 } }),
    } as Response;
  };

  await pi.tools['chrome_create_tab'].execute('call_1', { url: 'https://example.com' }, undefined);
  const p = sentPayload as { action: string; url: string };
  assert.equal(p.action, 'createTab');
  assert.equal(p.url, 'https://example.com');

  global.fetch = originalFetch;
});

test('chrome_select_tab sends correct payload', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true }),
    } as Response;
  };

  await pi.tools['chrome_select_tab'].execute('call_1', { tabId: 99 }, undefined);
  const p = sentPayload as { action: string; tabId: number };
  assert.equal(p.action, 'selectTab');
  assert.equal(p.tabId, 99);

  global.fetch = originalFetch;
});

test('chrome_release_tab sends correct payload', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true }),
    } as Response;
  };

  await pi.tools['chrome_release_tab'].execute('call_1', { tabId: 77, reason: 'done' }, undefined);
  const p = sentPayload as { action: string; tabId: number; reason: string };
  assert.equal(p.action, 'releaseTab');
  assert.equal(p.tabId, 77);
  assert.equal(p.reason, 'done');

  global.fetch = originalFetch;
});

test('chrome_cleanup_ai_tabs sends correct payload', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true }),
    } as Response;
  };

  await pi.tools['chrome_cleanup_ai_tabs'].execute('call_1', { closeTabs: false }, undefined);
  const p = sentPayload as { action: string; closeTabs: boolean };
  assert.equal(p.action, 'cleanupManagedTabs');
  assert.equal(p.closeTabs, false);

  global.fetch = originalFetch;
});

test('chrome_capture_video sends correct payload', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true, result: { framesDir: '/tmp/frames' } }),
    } as Response;
  };

  await pi.tools['chrome_capture_video'].execute('call_1', { tabId: 10 }, undefined);
  const p = sentPayload as { action: string; fps: number; duration: number; format: string; quality: number };
  assert.equal(p.action, 'captureVideo');
  assert.equal(p.fps, 5);
  assert.equal(p.duration, 3);
  assert.equal(p.format, 'jpeg');
  assert.equal(p.quality, 80);

  global.fetch = originalFetch;
});

test('chrome_type_text sends debugger batch with insertText', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true }),
    } as Response;
  };

  await pi.tools['chrome_type_text'].execute('call_1', { tabId: 3, text: 'hello' }, undefined);
  const p = sentPayload as { mode: string; actions: Array<{ method: string; commandParams: Record<string, unknown> }> };
  assert.equal(p.mode, 'sequential');
  assert.equal(p.actions[0].action, 'ensureDebugger');
  assert.equal(p.actions[1].method, 'Input.insertText');
  assert.equal(p.actions[1].commandParams.text, 'hello');
  assert.equal(p.actions[1].commandParams.sound, true);

  global.fetch = originalFetch;
});

test('chrome_type_text with instant mode disables animation', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true }),
    } as Response;
  };

  await pi.tools['chrome_type_text'].execute('call_1', { tabId: 3, text: 'hello', instant: true }, undefined);
  const p = sentPayload as { actions: Array<{ commandParams: Record<string, unknown> }> };
  assert.equal(p.actions[1].commandParams.animateTyping, false);

  global.fetch = originalFetch;
});

test('chrome_extract_content sends evaluateOnPage', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true, result: { headings: [], sections: [], links: [], tables: [] } }),
    } as Response;
  };

  await pi.tools['chrome_extract_content'].execute('call_1', { tabId: 1 }, undefined);
  const p = sentPayload as { action: string; returnByValue: boolean; expression: string };
  assert.equal(p.action, 'evaluateOnPage');
  assert.equal(p.returnByValue, true);
  assert.ok(p.expression.includes('maxDepth'));

  global.fetch = originalFetch;
});

test('chrome_extract_regions sends evaluateOnPage', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true, result: [] }),
    } as Response;
  };

  await pi.tools['chrome_extract_regions'].execute('call_1', { tabId: 1, minTextLength: 50 }, undefined);
  const p = sentPayload as { action: string; expression: string };
  assert.equal(p.action, 'evaluateOnPage');
  assert.ok(p.expression.includes('50'));

  global.fetch = originalFetch;
});

test('chrome_console_logs sends getConsoleLogs', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true, result: [] }),
    } as Response;
  };

  await pi.tools['chrome_console_logs'].execute('call_1', { tabId: 1, timeoutMs: 3000 }, undefined);
  const p = sentPayload as { action: string; timeoutMs: number; requestTimeoutMs: number };
  assert.equal(p.action, 'getConsoleLogs');
  assert.equal(p.timeoutMs, 3000);
  // The relay's wait: one ordinary round trip on top of the collection window.
  assert.equal(p.requestTimeoutMs, 18000);

  global.fetch = originalFetch;
});

test('chrome_evaluate with returnByValue false', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true, result: { result: { value: 42 } } }),
    } as Response;
  };

  await pi.tools['chrome_evaluate'].execute('call_1', { tabId: 1, expression: 'x', returnByValue: false }, undefined);
  const p = sentPayload as { returnByValue: boolean; awaitPromise: boolean };
  assert.equal(p.returnByValue, false);

  global.fetch = originalFetch;
});

test('chrome_evaluate with awaitPromise false', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true, result: { result: { value: 42 } } }),
    } as Response;
  };

  await pi.tools['chrome_evaluate'].execute('call_1', { tabId: 1, expression: 'x', awaitPromise: false }, undefined);
  const p = sentPayload as { returnByValue: boolean; awaitPromise: boolean };
  assert.equal(p.awaitPromise, false);

  global.fetch = originalFetch;
});

test('chrome_mouse move type sends single action', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true }),
    } as Response;
  };

  await pi.tools['chrome_mouse'].execute('call_1', { tabId: 1, type: 'move', x: 0, y: 0 }, undefined);
  const p = sentPayload as { actions: Array<{ action?: string; method?: string; commandParams: Record<string, unknown> }> };
  assert.equal(p.actions.length, 2); // ensureDebugger + move
  assert.equal(p.actions[1].method, 'Input.dispatchMouseEvent');
  assert.equal(p.actions[1].commandParams.type, 'mouseMoved');
  assert.equal(p.actions[1].commandParams.button, 'none');

  global.fetch = originalFetch;
});

test('chrome_mouse press type sends single action', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true }),
    } as Response;
  };

  await pi.tools['chrome_mouse'].execute('call_1', { tabId: 1, type: 'press', x: 10, y: 20 }, undefined);
  const p = sentPayload as { actions: Array<{ action?: string; method?: string; commandParams: Record<string, unknown> }> };
  assert.equal(p.actions.length, 2); // ensureDebugger + press
  assert.equal(p.actions[1].method, 'Input.dispatchMouseEvent');
  assert.equal(p.actions[1].commandParams.type, 'mousePressed');
  assert.equal(p.actions[1].commandParams.button, 'left');

  global.fetch = originalFetch;
});

test('chrome_mouse release type sends single action', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true }),
    } as Response;
  };

  await pi.tools['chrome_mouse'].execute('call_1', { tabId: 1, type: 'release', x: 10, y: 20 }, undefined);
  const p = sentPayload as { actions: Array<{ action?: string; method?: string; commandParams: Record<string, unknown> }> };
  assert.equal(p.actions.length, 2); // ensureDebugger + release
  assert.equal(p.actions[1].method, 'Input.dispatchMouseEvent');
  assert.equal(p.actions[1].commandParams.type, 'mouseReleased');
  assert.equal(p.actions[1].commandParams.button, 'left');

  global.fetch = originalFetch;
});

test('chrome_screenshot with jpeg format and quality', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  const restore = mockFetch({ data: Buffer.from('img').toString('base64'), format: 'jpeg' });

  try {
    const result = await pi.tools['chrome_screenshot'].execute('call_1', { tabId: 1, format: 'jpeg', quality: 85 }, undefined) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text) as { path: string };
    assert.ok(parsed.path.endsWith('.jpg'));
  } finally {
    restore();
  }
});

test('chrome_screenshot with webp format', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  const restore = mockFetch({ data: Buffer.from('img').toString('base64'), format: 'webp' });

  try {
    const result = await pi.tools['chrome_screenshot'].execute('call_1', { tabId: 1, format: 'webp' }, undefined) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text) as { path: string };
    assert.ok(parsed.path.endsWith('.webp'));
  } finally {
    restore();
  }
});

test('chrome_request throws error on HTTP failure', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'Extension not connected' }),
  } as Response);

  try {
    await assert.rejects(
      () => pi.tools['chrome_controller_health'].execute('call_1', {}, undefined),
      /Extension not connected/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('chrome_capture_video with custom params', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true, result: { framesDir: '/tmp/frames' } }),
    } as Response;
  };

  await pi.tools['chrome_capture_video'].execute('call_1', { tabId: 10, fps: 10, duration: 5, format: 'png', quality: 95 }, undefined);
  const p = sentPayload as { fps: number; duration: number; format: string; quality: number };
  assert.equal(p.fps, 10);
  assert.equal(p.duration, 5);
  assert.equal(p.format, 'png');
  assert.equal(p.quality, 95);

  global.fetch = originalFetch;
});

test('chrome_batch with sequential mode', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true }),
    } as Response;
  };

  await pi.tools['chrome_batch'].execute('call_1', { mode: 'sequential', actions: [{ action: 'queryTabs' }] }, undefined);
  const p = sentPayload as { action: string; mode: string; stopOnError: unknown };
  assert.equal(p.action, 'batch');
  assert.equal(p.mode, 'sequential');

  global.fetch = originalFetch;
});

test('chrome_mouse click with right button', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true }),
    } as Response;
  };

  await pi.tools['chrome_mouse'].execute('call_1', { tabId: 1, type: 'click', x: 50, y: 50, button: 'right' }, undefined);
  const p = sentPayload as { actions: Array<{ commandParams: Record<string, unknown>; events?: Array<{ type: string }> }> };
  assert.equal(p.actions[0].action, 'ensureDebugger');
  // click expands to: ensureDebugger + mouseMoved + mousePressed + mouseReleased
  assert.ok(p.actions.length >= 3);
  // Last action should be mouseReleased with the button
  const lastAction = p.actions[p.actions.length - 1];
  assert.equal(lastAction.commandParams.type, 'mouseReleased');
  assert.equal(lastAction.commandParams.button, 'right');

  global.fetch = originalFetch;
});

test('chrome_screenshot with nested data format', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  const restore = mockFetch({ data: { data: Buffer.from('nested').toString('base64') }, format: 'webp' });

  try {
    const result = await pi.tools['chrome_screenshot'].execute('call_1', { tabId: 1, format: 'webp' }, undefined) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text) as { path: string };
    assert.ok(parsed.path.endsWith('.webp'));
  } finally {
    restore();
  }
});

test('chrome_console_logs uses default timeout', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);

  let sentPayload: unknown;
  const originalFetch = global.fetch;
  global.fetch = async (_url: unknown, options?: RequestInit) => {
    sentPayload = JSON.parse(options?.body as string);
    return {
      ok: true,
      json: async () => ({ success: true, result: [] }),
    } as Response;
  };

  await pi.tools['chrome_console_logs'].execute('call_1', { tabId: 1 }, undefined);
  const p = sentPayload as { timeoutMs: number; requestTimeoutMs: number };
  assert.equal(p.timeoutMs, 2000);
  assert.equal(p.requestTimeoutMs, 17000);

  global.fetch = originalFetch;
});

// ── IPC client wait vs. the host's Chrome wait ──────────────────────────────

function nativeIpcEnv(socketPath: string): () => void {
  // An explicit relay URL skips Native Messaging, and relay permission must not mask a failure.
  return setEnv({
    CHROME_CONTROLLER_URL: undefined,
    CHROME_CONTROLLER_ALLOW_RELAY: undefined,
    HTTP_PORT: undefined,
    CHROME_CONTROLLER_SOCKET: socketPath,
  });
}

test('pi: a healthy host delivers its own Chrome timeout before the IPC client gives up', async (t) => {
  if (process.platform === 'win32') return;
  const chrome = await startScriptedChrome('pi-wait-order-');
  t.after(() => chrome.close());
  t.after(nativeIpcEnv(chrome.socketPath));
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const outcome = pi.tools['chrome_query_tabs'].execute('call_1', {}, undefined)
    .then((result) => JSON.stringify(result), (error: Error) => error.message);
  await chrome.nextRequest(); // Chrome has the request and never answers.
  t.mock.timers.tick(15000); // the host's default Chrome wait
  const text = await outcome;
  assert.match(text, /Native Messaging request timed out after 15000ms/);
  assert.doesNotMatch(text, /NATIVE_IPC_TIMEOUT/);
});

test('pi: console logs collected for the whole window reach the caller over Native Messaging', async (t) => {
  if (process.platform === 'win32') return;
  const chrome = await startScriptedChrome('pi-console-window-');
  t.after(() => chrome.close());
  t.after(nativeIpcEnv(chrome.socketPath));
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const outcome = pi.tools['chrome_console_logs'].execute('call_1', { tabId: 1 }, undefined);
  const request = await chrome.nextRequest();
  assert.equal(request.timeoutMs, 2000, 'the collection window still reaches the extension');
  // Measured on a live Chrome: the extension answers 2007ms after the request.
  t.mock.timers.tick(2007);
  chrome.answer(request.id, { logs: [], count: 0 });
  const result = await outcome as { details: { success?: boolean; result?: unknown; error?: string } };
  assert.equal(result.details.error, undefined);
  assert.deepEqual(result.details.result, { logs: [], count: 0 });
});

test('pi: a 22 s capture measured on a live Chrome reaches the caller', async (t) => {
  if (process.platform === 'win32') return;
  const chrome = await startScriptedChrome('pi-capture-');
  t.after(() => chrome.close());
  t.after(nativeIpcEnv(chrome.socketPath));
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as unknown as import("/Users/dst/dev/chrome-controller/node_modules/@earendil-works/pi-coding-agent/dist").ExtensionAPI);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const outcome = pi.tools['chrome_capture_video'].execute('call_1', { tabId: 1, fps: 30, duration: 2 }, undefined);
  const request = await chrome.nextRequest();
  t.mock.timers.tick(21968);
  chrome.answer(request.id, { count: 60 });
  const result = await outcome as { details: { result?: unknown; error?: string } };
  assert.equal(result.details.error, undefined);
  assert.deepEqual(result.details.result, { count: 60 });
});

