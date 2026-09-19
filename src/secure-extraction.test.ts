import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import {
  buildGuardedExtractionExpression,
  buildGuardedInjectionExpression,
} from './secure-extraction.js';

const CHROME_EXECUTABLES = [
  process.env['CHROME_PATH'],
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter((candidate): candidate is string => Boolean(candidate));

async function launchBrowser(): Promise<Browser> {
  for (const executablePath of CHROME_EXECUTABLES) {
    try {
      await fs.access(executablePath);
      return await chromium.launch({ executablePath, headless: true });
    } catch {
      // Try the next installed browser.
    }
  }
  return chromium.launch({ channel: 'chrome', headless: true });
}

test('guarded extraction scrubs synthetic DOM and accessibility output across rerenders', async () => {
  const browser = await launchBrowser();
  const synthetic = 'SyntheticGuardValue_42!';
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <style>#pseudo::before { content: "${synthetic}"; }</style>
      <main>
        <div id="source">${synthetic}</div>
        <div id="encoded"></div>
        <input id="field" aria-label="${synthetic}" value="${synthetic}">
        <div id="shadow-host"></div>
        <div id="pseudo"></div>
        <iframe id="frame"></iframe>
      </main>`);
    await page.evaluate((secret) => {
      const bytes = new TextEncoder().encode(secret);
      const binary = String.fromCharCode(...bytes);
      const base64 = btoa(binary);
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      document.querySelector('#encoded')!.textContent = [
        base64,
        base64.replace(/=+$/, ''),
        hex,
        hex.toUpperCase(),
        Array.from(secret).reverse().join(''),
      ].join(' ');
      document.querySelector('#shadow-host')!.attachShadow({ mode: 'open' }).innerHTML = `<span>${secret}</span>`;
      const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
      frame.contentDocument!.body.innerHTML = `<div aria-label="${secret}">${secret}</div>`;
    }, synthetic);

    const expression = buildGuardedExtractionExpression({ selector: '#source' });
    const result = await page.evaluate(expression) as {
      secret?: string;
      guard?: { guarded?: boolean; masked?: number; residual?: number };
    };
    assert.equal(result.secret, synthetic);
    assert.equal(result.guard?.guarded, true);
    assert.equal(result.guard?.residual, 0);
    assert.ok((result.guard?.masked ?? 0) >= 8);

    await page.evaluate((secret) => {
      const late = document.createElement('div');
      const bytes = new TextEncoder().encode(secret);
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      late.textContent = `late ${secret} ${hex} ${Array.from(secret).reverse().join('')}`;
      document.body.appendChild(late);
      document.querySelector<HTMLInputElement>('#field')!.value = secret;
      document.querySelector<HTMLInputElement>('#field')!.setAttribute('aria-label', secret);
      const host = document.createElement('div');
      document.body.appendChild(host);
      host.attachShadow({ mode: 'open' }).innerHTML = `<span>${secret}</span>`;
    }, synthetic);
    await page.waitForTimeout(50);

    const visible = await page.evaluate(() => ({
      text: document.body.innerText,
      aria: document.querySelector('#field')!.getAttribute('aria-label'),
      value: (document.querySelector('#field') as HTMLInputElement).value,
      shadow: document.querySelector('#shadow-host')!.shadowRoot!.textContent,
      frame: (document.querySelector('#frame') as HTMLIFrameElement).contentDocument!.body.textContent,
      pseudo: getComputedStyle(document.querySelector('#pseudo')!, '::before').content,
    }));
    const accessibility = await page.locator('body').ariaSnapshot();
    for (const output of [...Object.values(visible), accessibility]) {
      assert.ok(!String(output).includes(synthetic), 'synthetic value remained browser-visible');
    }
    assert.match(accessibility, /SECURE_CLIPBOARD_REDACTED/);
  } finally {
    await browser.close();
  }
});

test('guarded extraction scrubs aggregate text, iframe-realm rerenders, and marker-overlap secrets', async () => {
  const browser = await launchBrowser();
  const synthetic = 'SECURE';
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <div id="source">${synthetic}</div>
      <div id="split"><span>SEC</span><span>URE</span></div>
      <iframe id="frame"></iframe>`);
    await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
      frame.contentDocument!.body.innerHTML = '<input id="field" value="SECURE">';
    });

    const expression = buildGuardedExtractionExpression({ selector: '#source' });
    const result = await page.evaluate(expression) as {
      secret?: string;
      guard?: { guarded?: boolean; residual?: number };
    };
    assert.equal(result.secret, synthetic);
    assert.equal(result.guard?.guarded, true);
    assert.equal(result.guard?.residual, 0);

    await page.evaluate((secret) => {
      const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
      frame.contentWindow!.document.querySelector<HTMLInputElement>('#field')!.value = secret;
    }, synthetic);
    await page.waitForTimeout(50);

    const visible = await page.evaluate(() => ({
      split: document.querySelector('#split')!.textContent,
      frame: document.querySelector<HTMLIFrameElement>('#frame')!
        .contentDocument!.querySelector<HTMLInputElement>('#field')!.value,
    }));
    assert.ok(!visible.split?.includes(synthetic), 'adjacent text nodes reconstructed the secret');
    assert.ok(!visible.frame.includes(synthetic), 'iframe-realm value setter restored the secret');
  } finally {
    await browser.close();
  }
});

test('repeated guarded extractions keep prior setter guards and use a safe pseudo replacement', async () => {
  const browser = await launchBrowser();
  const first = 'SyntheticFirstValue_41!';
  const second = 'SyntheticSecondValue_52!';
  const marker = '[SECURE_CLIPBOARD_REDACTED]';
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <style>#pseudo::before { content: "${marker}"; }</style>
      <div id="source">${first}</div>
      <input id="field">
      <div id="pseudo"></div>`);

    const firstGuard = await page.evaluate(buildGuardedExtractionExpression({ expression: JSON.stringify(first) })) as {
      guard?: { guarded?: boolean; residual?: number };
    };
    assert.equal(firstGuard.guard?.guarded, true);
    const secondGuard = await page.evaluate(buildGuardedExtractionExpression({ expression: JSON.stringify(second) })) as {
      guard?: { guarded?: boolean; residual?: number };
    };
    assert.equal(secondGuard.guard?.guarded, true);
    const markerGuard = await page.evaluate(buildGuardedExtractionExpression({ expression: JSON.stringify(marker) })) as {
      guard?: { guarded?: boolean; residual?: number };
    };
    assert.equal(markerGuard.guard?.guarded, true);

    await page.evaluate((values) => {
      const field = document.querySelector<HTMLInputElement>('#field')!;
      field.value = values.first;
      const secondField = document.createElement('input');
      secondField.id = 'second-field';
      document.body.appendChild(secondField);
      secondField.value = values.second;
    }, { first, second });
    await page.waitForTimeout(25);

    const visible = await page.evaluate(() => ({
      first: document.querySelector<HTMLInputElement>('#field')!.value,
      second: document.querySelector<HTMLInputElement>('#second-field')!.value,
      pseudo: getComputedStyle(document.querySelector('#pseudo')!, '::before').content,
    }));
    assert.ok(!visible.first.includes(first));
    assert.ok(!visible.second.includes(second));
    assert.notEqual(visible.pseudo, JSON.stringify(marker));
    assert.ok(!visible.pseudo.includes(marker));
  } finally {
    await browser.close();
  }
});

test('clipboard-trap mode is rejected before page code can run', () => {
  assert.throws(
    () => buildGuardedExtractionExpression({ trapClipboard: true, clickSelector: '#copy' }),
    /disabled.*OS clipboard isolation/i,
  );
});

test('guarded injection uses the native setter and returns no plaintext result', async () => {
  const browser = await launchBrowser();
  const synthetic = 'SyntheticInjectionValue_73!';
  try {
    const page = await browser.newPage();
    await page.setContent('<input id="source"><input id="target">');

    const guard = buildGuardedExtractionExpression({
      expression: JSON.stringify(synthetic),
    });
    const guarded = await page.evaluate(guard) as { guard?: { guarded?: boolean } };
    assert.equal(guarded.guard?.guarded, true);

    const injection = buildGuardedInjectionExpression({ selector: '#target', value: synthetic });
    const result = await page.evaluate(injection) as Record<string, unknown>;
    assert.deepEqual(result, { injected: true });
    assert.ok(!JSON.stringify(result).includes(synthetic));
    assert.equal(await page.locator('#target').inputValue(), synthetic);
  } finally {
    await browser.close();
  }
});
