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

// Minimal mock Pi runtime
function makeMockPi() {
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
  chromeControllerPiExtension(pi as any);
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
  ];
  for (const name of expected) {
    assert.ok(name in pi.tools, `Missing tool: ${name}`);
  }
});

test('chrome_controller_health calls /health endpoint', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as any);

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

test('chrome_query_tabs returns short response by default', async () => {
  const pi = makeMockPi();
  chromeControllerPiExtension(pi as any);

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
  chromeControllerPiExtension(pi as any);

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
  chromeControllerPiExtension(pi as any);

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
  chromeControllerPiExtension(pi as any);

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
  chromeControllerPiExtension(pi as any);

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
  chromeControllerPiExtension(pi as any);

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

  const p = sentPayload as { mode: string; actions: unknown[] };
  assert.equal(p.mode, 'parallel');
  assert.equal(p.actions.length, 2);

  global.fetch = originalFetch;
});
