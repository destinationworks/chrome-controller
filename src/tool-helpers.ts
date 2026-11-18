/**
 * Shared helpers for Chrome Controller tools across the Pi extension and MCP server.
 */

export function finiteNumberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function isNativeOnlyRequest(action: string, params: Record<string, unknown>): boolean {
  if (action === 'extractSecretGuarded' || action === 'injectSecretGuarded' || params.sensitive === true) {
    return true;
  }
  const items = Array.isArray(params.actions)
    ? params.actions
    : (Array.isArray(params.commands) ? params.commands : []);
  return items.some(
    (item) =>
      Boolean(item) &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      ((item as Record<string, unknown>).action === 'extractSecretGuarded' ||
        (item as Record<string, unknown>).action === 'injectSecretGuarded' ||
        (item as Record<string, unknown>).sensitive === true),
  );
}

export function buildExtractContentExpression(params: {
  maxDepth?: unknown;
  maxLength?: unknown;
  includeLinks?: unknown;
  includeTables?: unknown;
  untruncated?: unknown;
}): string {
  const maxDepth = finiteNumberOrDefault(params.maxDepth, 3);
  const rawMaxLen = finiteNumberOrDefault(params.maxLength, 15000);
  const maxLength = params.untruncated ? 1000000 : rawMaxLen;
  const includeLinks = params.includeLinks !== false;
  const includeTables = params.includeTables !== false;
  return `(() => {
          const maxDepth = ${maxDepth};
          const maxLength = ${maxLength};
          const includeLinks = ${includeLinks};
          const includeTables = ${includeTables};

          const result = { headings: [], sections: [], links: [], tables: [] };
          let totalLen = 0;

          document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
            const level = parseInt(h.tagName[1]);
            if (level <= maxDepth && h.offsetParent) {
              result.headings.push({ level, text: h.innerText.trim().substring(0, 200) });
              totalLen += h.innerText.length;
            }
          });

          const textBlocks = [];
          const blockSelectors = 'p, li, blockquote, dt, dd, figcaption, td, th, .content, .text, .description';
          document.querySelectorAll(blockSelectors).forEach(el => {
            if (el.offsetParent && !el.closest('script, style, noscript, .chrome-controller-overlay-root')) {
              const text = el.innerText.trim();
              if (text.length > 10) textBlocks.push(text);
            }
          });

          const seen = new Set();
          textBlocks.forEach(text => {
            const key = text.substring(0, 50);
            if (!seen.has(key) && text.length <= 500) {
              seen.add(key);
              result.sections.push(text.substring(0, 500));
              totalLen += text.length;
            }
          });

          if (includeLinks) {
            document.querySelectorAll('a[href]').forEach(a => {
              if (a.offsetParent && a.innerText.trim()) {
                const text = a.innerText.trim().substring(0, 150);
                const href = a.getAttribute('href') || '';
                if (!seen.has('l:' + href.substring(0, 30))) {
                  seen.add('l:' + href.substring(0, 30));
                  result.links.push({ text, href });
                  totalLen += text.length + href.length;
                }
              }
            });
          }

          if (includeTables) {
            document.querySelectorAll('table').forEach(t => {
              if (t.offsetParent) {
                const rows = [];
                t.querySelectorAll('tr').forEach(tr => {
                  const cells = [];
                  tr.querySelectorAll('td, th').forEach(cell => { cells.push(cell.innerText.trim().substring(0, 200)); });
                  if (cells.length > 0) rows.push(cells);
                  if (rows.length >= 20) return;
                });
                if (rows.length > 0 && rows.length <= 50) { result.tables.push(rows); totalLen += rows.length * 100; }
              }
            });
          }

          if (totalLen > maxLength) {
            result.sections = result.sections.filter(s => s.length < 200);
            result.links = result.links.slice(0, 10);
          }

          return result;
        })()`;
}

export function buildExtractRegionsExpression(params: {
  minTextLength?: unknown;
  maxResults?: unknown;
  untruncated?: unknown;
}): string {
  const minLen = finiteNumberOrDefault(params.minTextLength, 30);
  const maxResults = finiteNumberOrDefault(params.maxResults, 50);
  const maxTextLen = params.untruncated ? 5000 : 500;
  return `(() => {
          const regions = [];
          const seen = new Set();
          const selectors = [
            '[class*="card"], [class*="item"], [class*="result"], [class*="post"]',
            '[class*="listing"], [class*="entry"], [class*="job"], [class*="vacancy"]',
            '[class*="product"], [class*="review"], [class*="comment"], [class*="article"]'
          ].join(',');

          document.querySelectorAll(selectors).forEach(el => {
            if (!el.offsetParent || el.closest('.chrome-controller-overlay-root')) return;
            const text = el.innerText.trim();
            if (text.length < ${minLen}) return;
            const cls = typeof el.className === 'string' ? el.className : '';
            const key = cls + ':' + text.substring(0, 40);
            if (seen.has(key)) return;
            seen.add(key);
            const links = [];
            el.querySelectorAll('a[href]').forEach(a => {
              links.push({ text: a.innerText.trim().substring(0, 100), href: a.getAttribute('href') });
            });
            regions.push({ class: cls, text: text.substring(0, ${maxTextLen}), links: links.slice(0, 3) });
            if (regions.length >= ${maxResults}) return;
          });

          return regions;
        })()`;
}
