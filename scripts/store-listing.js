// Reads docs/chrome-web-store-listing.md into the values each Developer Console field takes.
// The file is the only source for listing text, so every missing or malformed section
// throws: a publish run must never fill a console field from a partial parse.

const EDIT_LINK = /https:\/\/chrome\.google\.com\/webstore\/devconsole\/([0-9a-f-]{36})\/([a-p]{32})\/edit/;
export const SUMMARY_LIMIT = 132;
export const DESCRIPTION_LIMIT = 16_000;
export const HOST_PERMISSION = 'Host permission';
const FENCE = /^(`{3,})(.*)$/;

// Lines with their fence state, so headings and fences inside a text block are just text.
function scan(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let open = null;
  let openedAt = 0;
  const scanned = lines.map((line, index) => {
    const fence = FENCE.exec(line);
    const insideBefore = open !== null;
    if (fence && open === null) { open = fence[1]; openedAt = index + 1; }
    else if (fence && fence[1] === open && fence[2] === '') open = null;
    return { line, fenced: insideBefore || (fence !== null && !insideBefore) };
  });
  if (open !== null) throw new Error(`Listing file has a code fence opened on line ${openedAt} that never closes`);
  return scanned;
}

// The lines under a heading, up to the next heading of the same or a higher level.
function section(lines, level, title) {
  const heading = new RegExp(`^#{${level}} (?:\\d+\\. )?${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`);
  const start = lines.findIndex((entry) => !entry.fenced && heading.test(entry.line));
  if (start < 0) throw new Error(`Listing file has no "${title}" section`);
  const higher = new RegExp(`^#{1,${level}} `);
  const end = lines.findIndex((entry, index) => index > start && !entry.fenced && higher.test(entry.line));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

// The first ```text block. Its closing fence is the same backtick run alone on its line, so a
// description that shows a fenced example uses a longer outer fence (````text ... ````).
function textBlock(lines, title) {
  const start = lines.findIndex((entry) => /^`{3,}text$/.test(entry.line));
  if (start < 0) throw new Error(`"${title}" section has no \`\`\`text block`);
  const run = lines[start].line.slice(0, -'text'.length);
  const end = lines.findIndex((entry, index) => index > start && entry.line === run);
  if (end < 0) throw new Error(`"${title}" text block is not closed`);
  // An inner fence as long as the outer one would end the block early and drop the rest.
  const inner = lines.slice(start + 1, end).find((entry) => (FENCE.exec(entry.line)?.[1].length ?? 0) >= run.length);
  if (inner) throw new Error(`"${title}" text block contains the fence "${inner.line}"; wrap it in a longer fence`);
  return lines.slice(start + 1, end).map((entry) => entry.line).join('\n');
}

function field(lines, level, title) {
  return textBlock(section(lines, level, title), title);
}

// "name: value" lines; empty values, padding and repeated names are format errors.
function keyValueLines(text, title) {
  const entries = [];
  for (const line of text.split('\n')) {
    const separator = line.indexOf(': ');
    if (separator <= 0) throw new Error(`"${title}" line is not "name: value": ${line}`);
    const [name, value] = [line.slice(0, separator), line.slice(separator + 2)];
    if (!value.trim() || value !== value.trim() || name !== name.trim()) throw new Error(`"${title}" line has an empty or padded value: ${line}`);
    if (entries.some(([seen]) => seen === name)) throw new Error(`"${title}" names "${name}" twice`);
    entries.push([name, value]);
  }
  return entries;
}

export function parseListing(markdown) {
  const link = EDIT_LINK.exec(markdown);
  if (!link) throw new Error('Listing file has no Developer Console edit link');
  const lines = scan(markdown);
  const details = Object.fromEntries(keyValueLines(field(lines, 2, 'Category and Language'), 'Category and Language'));
  const privacy = section(lines, 2, 'Privacy Practices Tab');
  return {
    publisherId: link[1],
    itemId: link[2],
    summary: field(lines, 2, 'Summary'),
    description: field(lines, 2, 'Detailed Description'),
    homepageUrl: field(lines, 2, 'Homepage URL'),
    supportUrl: field(lines, 2, 'Support URL'),
    privacyPolicyUrl: field(lines, 2, 'Privacy Policy URL'),
    category: details.Category,
    language: details.Language,
    singlePurpose: field(privacy, 3, 'Single purpose description'),
    permissionJustifications: keyValueLines(field(privacy, 3, 'Permission justifications'), 'Permission justifications'),
  };
}

// Problems that would make the console reject the listing or misdescribe the package.
export function validateListing(listing, manifest) {
  const problems = [];
  if (!listing.summary || listing.summary.length > SUMMARY_LIMIT) {
    problems.push(`summary must be 1-${SUMMARY_LIMIT} characters, got ${listing.summary.length}`);
  }
  if (listing.summary.includes('\n')) problems.push('summary must be a single line');
  // The console has no summary field: it shows the package manifest's description.
  if (listing.summary !== manifest.description) problems.push('summary must equal the manifest description, which the console shows as the summary');
  if (listing.description.length > DESCRIPTION_LIMIT) {
    problems.push(`description must be at most ${DESCRIPTION_LIMIT} characters, got ${listing.description.length}`);
  }
  if (!listing.description.includes(`WHAT'S NEW IN ${manifest.version}\n`)) {
    problems.push(`description release notes must name manifest version ${manifest.version}`);
  }
  for (const [name, url] of [['homepage', listing.homepageUrl], ['support', listing.supportUrl], ['privacy policy', listing.privacyPolicyUrl]]) {
    if (!/^https:\/\/\S+$/.test(url)) problems.push(`${name} URL must be one https URL, got "${url}"`);
  }
  if (!listing.singlePurpose.trim()) problems.push('single purpose description is empty');
  if (!listing.category) problems.push('category is missing');
  if (!listing.language) problems.push('language is missing');
  const justified = listing.permissionJustifications.map(([name]) => name);
  const expected = [...(manifest.permissions ?? [])];
  if ((manifest.host_permissions ?? []).length > 0 || (manifest.content_scripts ?? []).length > 0) expected.push(HOST_PERMISSION);
  for (const name of expected) if (!justified.includes(name)) problems.push(`no justification for permission "${name}"`);
  for (const name of justified) if (!expected.includes(name)) problems.push(`justification for "${name}", which the manifest does not request`);
  return problems;
}
