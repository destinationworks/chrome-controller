import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const currentFile = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFile);
const repoRoot = path.resolve(scriptsDir, '..');
const extensionDir = path.join(repoRoot, 'Chrome Extension');
const outputDir = path.join(repoRoot, 'store-assets');
const legacyOutputDir = path.join(repoRoot, 'dist');

const CHROME_EXECUTABLES = [
  process.env['CHROME_PATH'],
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

async function chromeExecutable() {
  for (const executable of CHROME_EXECUTABLES) {
    try {
      await fs.access(executable);
      return executable;
    } catch {
      // Try the next supported executable.
    }
  }
  throw new Error('Google Chrome or Chromium is required to render store assets. Set CHROME_PATH to its executable.');
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function documentHtml({ title, styles, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    ${styles}
  </style>
</head>
<body>${body}</body>
</html>`;
}

async function renderHtml(browser, { width, height, html, outputPath, type = 'jpeg' }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: outputPath,
    type,
    ...(type === 'jpeg' ? { quality: 94 } : { omitBackground: true }),
  });
  await context.close();
}

async function renderIcon(browser, svg, size, outputPath) {
  const html = documentHtml({
    title: 'p agent extension icon',
    styles: 'body { background: transparent; } img { display: block; width: 100%; height: 100%; }',
    body: `<img alt="p agent extension" src="${svgDataUrl(svg)}">`,
  });
  await renderHtml(browser, { width: size, height: size, html, outputPath, type: 'png' });
}

function brandMark(svg, size, className = '') {
  return `<img class="${className}" width="${size}" height="${size}" alt="" src="${svgDataUrl(svg)}">`;
}

export function screenshotHtml(svg) {
  const styles = `
    body { background: #eef4fa; color: #17233a; }
    .app-bar { height: 76px; display: flex; align-items: center; gap: 14px; padding: 0 34px; border-bottom: 1px solid #dce6f1; background: rgba(255,255,255,.96); }
    .app-name { font-size: 18px; font-weight: 780; letter-spacing: -.02em; }
    .app-state { margin-left: auto; display: flex; align-items: center; gap: 8px; color: #287a62; font-size: 13px; font-weight: 700; }
    .app-state::before { content: ''; width: 9px; height: 9px; border-radius: 99px; background: #35d39a; box-shadow: 0 0 0 5px rgba(53,211,154,.13); }
    .workspace { display: grid; grid-template-columns: 292px 1fr; height: 724px; }
    .sidebar { padding: 34px 26px; border-right: 1px solid #dce6f1; background: #f8fbfe; }
    .eyebrow { color: #2588b5; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 12px 0 10px; color: #13213a; font-size: 34px; line-height: 1.08; letter-spacing: -.04em; }
    .lead { margin: 0; color: #607089; font-size: 15px; line-height: 1.55; }
    .step-list { display: grid; gap: 12px; margin-top: 32px; }
    .step { display: grid; grid-template-columns: 28px 1fr; gap: 10px; align-items: center; color: #52627a; font-size: 13px; font-weight: 650; }
    .step span { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid #c9d9e9; border-radius: 8px; background: #fff; color: #2588b5; }
    .step.active { color: #13213a; }
    .step.active span { border-color: #25b8d7; background: #e5f9fd; box-shadow: 0 0 0 4px rgba(37,184,215,.1); }
    .content { padding: 36px 38px; }
    .content-head { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 24px; }
    .content-head h2 { margin: 0; font-size: 23px; letter-spacing: -.025em; }
    .content-head p { margin: 6px 0 0; color: #728098; font-size: 13px; }
    .run-pill { padding: 9px 13px; border: 1px solid #bae7f1; border-radius: 999px; background: #ecfbfe; color: #167e98; font-size: 12px; font-weight: 750; }
    .search { display: flex; align-items: center; gap: 10px; height: 48px; padding: 0 16px; border: 1px solid #cfdce9; border-radius: 12px; background: #fff; color: #718199; box-shadow: 0 10px 28px rgba(40,68,105,.06); }
    .search strong { color: #24334a; font-size: 14px; }
    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 18px; }
    .card { min-height: 190px; padding: 18px; border: 1px solid #d8e3ee; border-radius: 15px; background: #fff; box-shadow: 0 12px 30px rgba(38,65,98,.06); }
    .card-icon { display: grid; width: 38px; height: 38px; place-items: center; border-radius: 11px; background: #e9f9fc; color: #168aa7; font-weight: 850; }
    .card h3 { margin: 18px 0 8px; font-size: 16px; }
    .card p { margin: 0; color: #728098; font-size: 13px; line-height: 1.48; }
    .action-row { display: flex; align-items: center; justify-content: space-between; margin-top: 22px; padding: 20px 22px; border: 1px solid #d5e2ee; border-radius: 15px; background: linear-gradient(135deg,#fff,#f7fbfe); }
    .action-row strong { display: block; font-size: 16px; }
    .action-row small { display: block; margin-top: 5px; color: #74839a; }
    .primary { position: relative; min-width: 178px; padding: 13px 18px; border: 0; border-radius: 11px; background: linear-gradient(135deg,#0ca8c7,#2878e6); color: #fff; font-size: 14px; font-weight: 800; box-shadow: 0 10px 24px rgba(19,134,197,.28); }
    .badge { position: absolute; z-index: 5; display: grid; width: 24px; height: 22px; place-items: center; border-radius: 6px; background: #06b6d4; color: #0f172a; font-size: 12px; font-weight: 900; box-shadow: 0 3px 8px rgba(15,23,42,.24); }
    .badge.one { left: 318px; top: 149px; } .badge.two { left: 317px; top: 218px; } .badge.three { right: 224px; bottom: 303px; }
  `;

  const body = `
    <header class="app-bar">${brandMark(svg, 42)}<div class="app-name">p agent extension</div><div class="app-state">Local bridge connected</div></header>
    <main class="workspace">
      <aside class="sidebar"><div class="eyebrow">Live browser control</div><h1>Let your agent work with the web.</h1><p class="lead">Visible, local browser automation with tab control, element targeting, screenshots, and an on-page activity HUD.</p><div class="step-list"><div class="step"><span>1</span>Inspect the active page</div><div class="step active"><span>2</span>Target visible controls</div><div class="step"><span>3</span>Complete the workflow</div></div></aside>
      <section class="content"><div class="content-head"><div><h2>Research workspace</h2><p>A neutral demo page with safe sample content.</p></div><div class="run-pill">Agent working locally</div></div><div class="search">⌕ <strong>Find browser automation capabilities</strong></div><div class="cards"><article class="card"><div class="card-icon">01</div><h3>Tab management</h3><p>Open, select, group, and release controlled tabs while keeping the active target visible.</p></article><article class="card"><div class="card-icon">02</div><h3>Element interaction</h3><p>Tag interactive controls, click elements, enter text, and choose options.</p></article><article class="card"><div class="card-icon">03</div><h3>Visual evidence</h3><p>Capture screenshots and surface coordinates, actions, and browser errors.</p></article></div><div class="action-row"><div><strong>Ready to run the selected action</strong><small>The HUD shows exactly what the agent is doing.</small></div><button id="generate-report" class="primary">Generate report</button></div></section>
    </main>
  `;
  return documentHtml({ title: 'p agent extension in action', styles, body });
}

function smallPromoHtml(svg) {
  return documentHtml({
    title: 'p agent extension small promo tile',
    styles: `
      body { display: grid; place-items: center; background: radial-gradient(circle at 78% 18%, rgba(41,180,225,.3), transparent 36%), linear-gradient(135deg,#0b1425,#142640); color: #f7fbff; }
      .tile { display: flex; width: 100%; height: 100%; align-items: center; gap: 24px; padding: 36px; border: 3px solid rgba(44,200,235,.78); }
      h1 { margin: 0 0 9px; font-size: 30px; letter-spacing: -.04em; }
      p { margin: 0; color: #b7d4e3; font-size: 15px; font-weight: 600; line-height: 1.35; }
    `,
    body: `<div class="tile">${brandMark(svg, 106)}<div><h1>p agent extension</h1><p>Local browser control<br>for AI agents</p></div></div>`,
  });
}

function marqueePromoHtml(svg) {
  return documentHtml({
    title: 'p agent extension marquee promo tile',
    styles: `
      body { position: relative; display: flex; align-items: center; padding: 70px 86px; background: radial-gradient(circle at 78% 20%, rgba(27,185,226,.28), transparent 30%), linear-gradient(120deg,#08111f 0%,#132842 100%); color: #f7fbff; }
      body::after { content: ''; position: absolute; inset: 14px; border: 2px solid rgba(48,202,236,.7); border-radius: 22px; box-shadow: inset 0 0 60px rgba(29,164,221,.1); }
      .copy { position: relative; z-index: 2; width: 51%; }
      .brand { display: flex; align-items: center; gap: 20px; color: #bdeafa; font-size: 18px; font-weight: 800; }
      h1 { margin: 30px 0 16px; font-size: 56px; line-height: 1.02; letter-spacing: -.055em; }
      p { max-width: 530px; margin: 0; color: #b7d1e0; font-size: 21px; line-height: 1.45; }
      .browser { position: absolute; z-index: 2; right: 70px; top: 70px; width: 550px; height: 420px; overflow: hidden; border: 1px solid rgba(161,220,239,.32); border-radius: 20px; background: #f5f9fd; box-shadow: 0 30px 80px rgba(0,0,0,.38); transform: rotate(-1.2deg); }
      .chrome { height: 50px; display: flex; align-items: center; gap: 9px; padding: 0 16px; background: #e7eef5; }
      .chrome i { width: 10px; height: 10px; border-radius: 50%; background: #aec0d0; }
      .address { width: 360px; height: 25px; margin-left: 8px; border-radius: 8px; background: white; }
      .page { display: grid; grid-template-columns: 130px 1fr; height: 370px; }
      .side { background: #edf4f9; }
      .main { padding: 28px; }
      .line { height: 13px; margin-bottom: 13px; border-radius: 99px; background: #d8e4ed; }
      .line.accent { width: 48%; background: #54c8df; }
      .cards { display: grid; grid-template-columns: repeat(2,1fr); gap: 14px; margin-top: 26px; }
      .card { height: 120px; border: 1px solid #dbe6ee; border-radius: 12px; background: white; }
      .hud { position: absolute; right: 18px; top: 68px; width: 230px; padding: 14px; border: 1px solid rgba(97,223,250,.35); border-radius: 11px; background: linear-gradient(135deg,rgba(7,13,22,.96),rgba(13,30,42,.94)); color: white; box-shadow: 0 18px 40px rgba(0,0,0,.28),0 0 28px rgba(33,184,255,.18); }
      .status { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 850; text-transform: uppercase; }
      .dot { width: 9px; height: 9px; border-radius: 50%; background: #56f0b2; box-shadow: 0 0 14px rgba(86,240,178,.8); }
      .feed { margin-top: 12px; color: #b8d7e4; font: 11px ui-monospace, monospace; line-height: 1.7; }
    `,
    body: `<section class="copy"><div class="brand">${brandMark(svg, 72)} p agent extension</div><h1>Browser control your agent can show.</h1><p>Local tab automation, element interaction, screenshots, and a visible activity HUD.</p></section><div class="browser"><div class="chrome"><i></i><i></i><i></i><div class="address"></div></div><div class="page"><div class="side"></div><div class="main"><div class="line accent"></div><div class="line"></div><div class="line" style="width:72%"></div><div class="cards"><div class="card"></div><div class="card"></div></div></div></div><div class="hud"><div class="status"><span class="dot"></span>Controller active</div><div class="feed">Selected tab · Demo workspace<br>Snapshot · 6 elements<br>Click · #continue</div></div></div>`,
  });
}

export async function generateIcons() {
  await fs.mkdir(outputDir, { recursive: true });
  const svg = await fs.readFile(path.join(extensionDir, 'icon128.svg'), 'utf8');
  const browser = await chromium.launch({ executablePath: await chromeExecutable(), headless: true });
  try {
    for (const size of [16, 48, 128]) {
      await renderIcon(browser, svg, size, path.join(extensionDir, `icon${size}.png`));
    }
    await fs.copyFile(path.join(extensionDir, 'icon128.png'), path.join(outputDir, 'store-icon-128.png'));
  } finally {
    await browser.close();
  }
  console.log(`Generated extension and store icons in ${extensionDir} and ${outputDir}`);
}

export async function generateStoreAssets() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(legacyOutputDir, { recursive: true });
  const svg = await fs.readFile(path.join(extensionDir, 'icon128.svg'), 'utf8');
  const browser = await chromium.launch({ executablePath: await chromeExecutable(), headless: true });
  try {
    await renderIcon(browser, svg, 128, path.join(extensionDir, 'icon128.png'));
    await fs.copyFile(path.join(extensionDir, 'icon128.png'), path.join(outputDir, 'store-icon-128.png'));
    await renderHtml(browser, { width: 1280, height: 800, html: screenshotHtml(svg), outputPath: path.join(legacyOutputDir, 'store_screenshot_preview.jpg') });
    await renderHtml(browser, { width: 440, height: 280, html: smallPromoHtml(svg), outputPath: path.join(outputDir, 'small-promo-440x280.jpg') });
    await renderHtml(browser, { width: 1400, height: 560, html: marqueePromoHtml(svg), outputPath: path.join(outputDir, 'marquee-promo-1400x560.jpg') });
  } finally {
    await browser.close();
  }
  console.log(`Generated Chrome Web Store assets in ${outputDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateStoreAssets();
}
