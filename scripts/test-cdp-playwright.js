import { chromium } from 'playwright-core';

async function main() {
  console.log('Connecting Playwright to Chrome via CDP on http://127.0.0.1:9222...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  console.log(`Connected! Active browser contexts: ${contexts.length}`);

  for (const ctx of contexts) {
    const pages = ctx.pages();
    for (const page of pages) {
      console.log(`Page: title="${await page.title()}" url="${page.url()}"`);
    }
  }

  await browser.disconnect();
}

main().catch(console.error);
