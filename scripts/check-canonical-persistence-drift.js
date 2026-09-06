import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const paths = [...new Set([...tracked, ...untracked])];
const violations = [];
const seenViolations = new Set();

function violation(message) {
  if (seenViolations.has(message)) return;
  seenViolations.add(message);
  violations.push(message);
}

const sourceForbidden = [
  /latestClosedRecordEntry/u,
  /readRecord\([^)]*['"](?:latest|open)['"]/u,
  /record:\/\/\/[^\s'"`]*[?&]v=next/u,
  /\bWebfetchWriteSchema\b/u,
  /\btarget_url\b/u,
  /\blist_card_history\b|\bget_card_history_entry\b|\bdiff_card\b/u,
  /\breadBoundedConversation\b/u,
  /\bthrough_message_id\b/u,
  /\bmutation_url\b/u,
];

const retiredIdentifiers = [
  'cardStorageRoot',
  'cardVersionIndexFile',
  'cardVersionsRoot',
  'cardVersionFile',
  'cardRecordsRoot',
  'cardRecordRoot',
  'cardRecordVersionIndexFile',
  'cardRecordVersionsRoot',
  'cardRecordVersionFile',
  'cardVersionIndexSchema',
  'CardVersionIndex',
  'CardVersionEntry',
  'authoredRecordVersionIndexSchema',
  'AuthoredRecordVersionIndex',
  'RecordVersionEntry',
  'initializeDynamicAuthoredRecord',
  'RecordPriorHeadInvariantError',
  'AuthoredRecordHistoricalUnavailableError',
  'HistoricalUnavailableReason',
];

const retiredDiscriminators = /card-version-index|authored-record-version-index/u;
const recordOwnerModules = new Set(['src/persistence/card-files.ts', 'src/persistence/authored-record-files.ts', 'src/persistence/canonical-card-artifacts.ts', 'src/persistence/canonical-record-artifacts.ts']);
const pathConstructionFiles = new Set(['src/persistence/layout.ts', 'src/schemas/record-name.ts', 'src/persistence/card-files.ts', 'src/persistence/authored-record-files.ts']);

const cardRecordDocPaths = new Set(['README.md', 'README-IF-YOU-ARE-AN-AI.md', 'docs/spec/system-specification.md', 'docs/spec/operator-ui.md', 'docs/architecture/system-architecture.md', 'docs/architecture/index.md', 'docs/runbook/index.md']);
function isAllDocPath(path) {
  return path === 'README.md'
    || path === 'README-IF-YOU-ARE-AN-AI.md'
    || path.startsWith('docs/spec/')
    || path.startsWith('docs/architecture/')
    || path.startsWith('docs/runbook/');
}

// Each rule names one obsolete assertion. A positive match is a violation unless one of the
// rule's negated expressions overlaps that exact match span; the negation must therefore be
// attached to the matched assertion itself in the same sentence, never merely elsewhere on the line.
// Each negated expression names exactly one subject so a lazy match cannot stop at an earlier
// alternative and fail to cover the matched positive span.
const negators = String.raw`\b(?:no|not|never|without|unsupported|removed|reject(?:s|ed)?|fail(?:s|ed)?)\b`;
function negatedBefore(subject, window = 160) {
  return new RegExp(`${negators}[^.\\n]{0,${window}}?${subject}`, 'giu');
}

const cardRecordDocRules = [
  {
    label: 'card/authored-record index.json authority',
    positive: /\b(?:card|record)[^.\n]{0,80}index\.json/giu,
    negated: [negatedBefore(String.raw`index\.json`, 80)],
  },
  {
    label: 'card/authored-record index/head selection authority',
    positive: /\bindexed heads?\b|\bindexed (?:card|record)[^.\n]{0,40}heads?\b|current-head selector|\bindexed artifacts?\b|\bfinal indexed\b|\bindex and head\b|\bindex plus head\b|\bopen index plus head\b|history lists index only|indexes\/heads\b|history opens only (?:its|the) index|(?:card|record)\b[^.\n]{0,60}index names immutable/giu,
    negated: [negatedBefore(String.raw`indexed`, 60), negatedBefore(String.raw`current-head`, 60), negatedBefore(String.raw`index and head`, 60), negatedBefore(String.raw`index plus`, 60), negatedBefore(String.raw`indexes\/heads`, 60)],
  },
  {
    label: 'random immutable card/record artifact naming',
    positive: /N-<uuid>\.json/giu,
    negated: [negatedBefore(String.raw`N-<uuid>\.json`, 80)],
  },
  {
    label: 'cumulative card/authored-record index/catalog authority',
    positive: /strict cumulative (?:card|record)|(?:card|record)\b[^.\n]{0,40}cumulative index|cumulative index[^.\n]{0,40}\b(?:card|record)\b|version catalogs? are durable|card-version index|version-index catalog|\bcard index(?:es)?\b|\brecord index(?:es)?\b|indexes?\/artifacts?|namespace\/index/giu,
    negated: [negatedBefore(String.raw`version catalogs?`, 120), negatedBefore(String.raw`card index`, 120), negatedBefore(String.raw`record index`, 120)],
  },
  {
    label: 'optional existing-empty card/record authority',
    positive: /\bstrict(?:ly)? empty\b|\bempty-index\b|\bempty history\b|(?:optional|record|declared)[^.\n]{0,4}index(?:es)?[^.\n]{0,30}\bempty\b|empty (?:optional|record|declared)[^.\n]{0,30}index/giu,
    negated: [negatedBefore(String.raw`strict(?:ly)? empty`), negatedBefore(String.raw`empty-index`), negatedBefore(String.raw`empty history`), negatedBefore(String.raw`empty (?:optional|record|declared)[^.\n]{0,30}index`)],
  },
  {
    label: 'existing-empty app-log acceptance',
    positive: /missing or truly zero-byte|zero-byte initialization state|zero-byte[^.\n]{0,60}\b(?:absent|valid|missing|accepted)\b/giu,
    negated: [],
  },
  {
    label: 'positive migration instruction',
    positive: /\bmigrat(?:e|es|ed|ion|ing)\b/giu,
    negated: [
      negatedBefore(String.raw`migrat`),
      /migrat\w*[^.\n]{0,160}?\b(?:unsupported|not supported|do(?:es)? not exist)\b/giu,
    ],
  },
  {
    label: 'positive fallback instruction',
    positive: /\bfalls? back to\b|\bfallback (?:to|route|reader|path|mode|interpretation|summarizer|shape|format)\b|(?:config|file|physical|compatibility|format|legacy) fallback\b/giu,
    negated: [
      negatedBefore(String.raw`falls? back to`),
      negatedBefore(String.raw`fallback (?:to|route|reader|path|mode|interpretation|summarizer|shape|format)`),
      negatedBefore(String.raw`(?:config|file|physical|compatibility|format|legacy) fallback`),
      /(?:fallback|falls? back to)[^.\n]{0,120}?\b(?:unsupported|do(?:es)? not exist|never)\b/giu,
    ],
  },
  {
    label: 'positive compatibility/probing/old-layout instruction',
    positive: /format probing|format probes?\b|compatibility probing|compatibility[-\s](?:read|render|probe)s?|compatibility bridge|probes? (?:for|against) compatibility|old-layout (?:probe|probing|detection|enumeration)/giu,
    negated: [
      negatedBefore(String.raw`format prob`),
      negatedBefore(String.raw`format probing`),
      negatedBefore(String.raw`compatibilit`),
      negatedBefore(String.raw`old-layout`),
      /(?:format probing|format probes?)[^.\n]{0,160}?are unsupported/giu,
      /compatibilit\w*[^.\n]{0,160}?\b(?:unsupported|do(?:es)? not exist)\b/giu,
    ],
  },
  {
    label: 'positive mixed-format/dual-path instruction',
    positive: /mixed-format|dual-path|dual write|\bmixed version/giu,
    negated: [negatedBefore(String.raw`mixed-format`), negatedBefore(String.raw`dual-path`), negatedBefore(String.raw`dual write`), negatedBefore(String.raw`mixed version`)],
  },
  {
    label: 'unprefixed physical record-name-to-.jsonl mapping',
    positive: /\$\{stem\}\.jsonl|`[a-z][a-z0-9-]*\.md`\s*(?:→|to)\s*`[a-z][a-z0-9-]*\.jsonl`/giu,
    negated: [],
  },
  {
    label: 'head-token/prior-head mutation authority',
    positive: /\bexpected_head\b|\bmutation_url\b|expected-head|prior[- ]head|head tokens?|selected heads?\b|predecessor fallback|predecessor is promoted|selects? exactly (?:its|the) head|\bshortening [^.\n]{0,20}index\b|\bopens? a predecessor\b/giu,
    negated: [
      negatedBefore(String.raw`head tokens?`, 60),
      /never teach[^.\n]{0,80}?head tokens?/giu,
      negatedBefore(String.raw`predecessor is promoted`, 60),
      negatedBefore(String.raw`shortening`, 60),
      negatedBefore(String.raw`opens? a predecessor`, 60),
    ],
  },
  {
    label: 'retired card/record historical-unavailability and unindexed-artifact language',
    positive: /historical-unavailable|typed local historical|\bunindexed files?\b|\bdeclared namespaces?\b|\brecords? root\b|non-current files?/giu,
    negated: [],
  },
];

const allDocRules = [
  {
    label: 'retired model-tool/old-contract guidance',
    positive: /latest[- ]closed|record:\/\/\/[^\s`]*[?&]v=next|\blist_card_history\b|\bget_card_history_entry\b|\bdiff_card\b|six ordered phases|accept(?:s|ed|ing)? a (?:strictly )?valid existing project card/giu,
    negated: [
      negatedBefore(String.raw`latest[- ]closed`, 80),
      negatedBefore(String.raw`v=next`, 80),
      negatedBefore(String.raw`list_card_history`, 80),
      negatedBefore(String.raw`get_card_history_entry`, 80),
      negatedBefore(String.raw`diff_card`, 80),
      /never teach[^.\n]{0,80}?v=next/giu,
    ],
  },
];

function uncoveredPositiveSpans(rule, line) {
  const positiveSpans = [];
  for (const match of line.matchAll(rule.positive)) positiveSpans.push([match.index, match.index + match[0].length]);
  if (positiveSpans.length === 0) return [];
  const negatedSpans = [];
  for (const pattern of rule.negated ?? []) for (const match of line.matchAll(pattern)) negatedSpans.push([match.index, match.index + match[0].length]);
  return positiveSpans.filter(([start, end]) => !negatedSpans.some(([negatedStart, negatedEnd]) => negatedStart < end && start < negatedEnd));
}

for (const path of paths) {
  if (!existsSync(path) || path.startsWith('docs/working/') || path === 'scripts/check-canonical-persistence-drift.js') continue;
  if (!path.startsWith('src/') && !isAllDocPath(path)) continue;
  const content = readFileSync(path, 'utf8');
  if (path.startsWith('src/')) {
    for (const pattern of sourceForbidden) if (pattern.test(content)) violation(`${path}: forbidden obsolete persistence or model-tool contract`);
    for (const identifier of retiredIdentifiers) if (new RegExp(`\\b${identifier}\\b`, 'u').test(content)) violation(`${path}: retired card/authored-record identifier '${identifier}'`);
    if (retiredDiscriminators.test(content)) violation(`${path}: retired card/authored-record index discriminator`);
    if (recordOwnerModules.has(path) && /\bcurrent_filename\b|\bentry_filename\b/u.test(content)) violation(`${path}: retired card/authored-record index filename field`);
    if ((path === 'src/persistence/card-files.ts' || path === 'src/persistence/authored-record-files.ts') && /readdirSync|opendir|scandir/u.test(content)) violation(`${path}: canonical version discovery is forbidden`);
    if (pathConstructionFiles.has(path) && /['"`]\$\{[^}]+\}\.jsonl|\.replace\([^)]*\.jsonl|\+\s*['"`]\.jsonl['"`]/u.test(content)) violation(`${path}: unprefixed record-name-to-.jsonl physical mapping is forbidden`);
    if (path === 'src/persistence/app-log.ts') {
      if (/message\s*(?:===|!==|\.includes|\.startsWith|\.match)/u.test(content)) violation(`${path}: strict-reader failure classified by message text`);
      if (/zero[- ]byte|\.size\s*===?\s*0|byteLength\s*===?\s*0|isEmpty/u.test(content)) violation(`${path}: empty canonical stream classified as missing`);
      if (!/code\s*===\s*'ENOENT'/u.test(content)) violation(`${path}: missing admission must be keyed only by exact ENOENT`);
    }
    continue;
  }
  const scopedRules = cardRecordDocPaths.has(path) ? cardRecordDocRules : [];
  for (const [offset, line] of content.split('\n').entries()) {
    for (const rule of [...scopedRules, ...allDocRules]) {
      for (const [start, end] of uncoveredPositiveSpans(rule, line)) violation(`${path}:${offset + 1}:${start + 1}-${end}: ${rule.label}`);
    }
  }
}

const layout = existsSync('src/persistence/layout.ts') ? readFileSync('src/persistence/layout.ts', 'utf8') : '';
if (!/function cardStreamFile/u.test(layout) || !layout.includes("'card.jsonl'")) violation('src/persistence/layout.ts: missing exact card.jsonl stream path helper');
const recordName = existsSync('src/schemas/record-name.ts') ? readFileSync('src/schemas/record-name.ts', 'utf8') : '';
if (!/function recordStreamFilename/u.test(recordName) || !recordName.includes('`record-${') || !recordName.includes('.jsonl`')) violation('src/schemas/record-name.ts: missing record-<stem>.jsonl stream filename helper');

const requiredDocPhrases = [
  ['docs/spec/system-specification.md', ['card.jsonl', 'record-<stem>.jsonl']],
  ['docs/architecture/system-architecture.md', ['card.jsonl', 'record-<stem>.jsonl']],
  ['docs/runbook/index.md', ['card.jsonl', 'record-<stem>.jsonl']],
  ['docs/spec/operator-ui.md', ['one strict stream']],
];
for (const [doc, phrases] of requiredDocPhrases) {
  if (!existsSync(doc)) { violation(`${doc}: required canonical document missing`); continue; }
  const content = readFileSync(doc, 'utf8');
  for (const phrase of phrases) if (!content.includes(phrase)) violation(`${doc}: missing required exact-stream assertion '${phrase}'`);
}

const guide = existsSync('README-IF-YOU-ARE-AN-AI.md') ? readFileSync('README-IF-YOU-ARE-AN-AI.md', 'utf8') : '';
for (const required of [
  '## Stage 4 — Initialize and configure',
  '## Stage 5 — Confine access, install, and start',
  '## Stage 6 — Verify and teach first use',
  '## Stage 7 — Hand off and present later options',
  'docs/spec/system-specification.md#9-direct-file-persistence',
  'docs/runbook/index.md#storage-and-interruption',
  'no live lifecycle owner',
  'four generated roots wholesale',
  'permanently destroys generated cards, records, conversations, and history',
  'before the first listener',
  'Requires=nftables.service',
  'After that actual restart, prove all of the following again:',
  'stop and disable',
  'Authorization header',
  'never in a URL',
]) {
  if (!guide.includes(required)) violation(`README-IF-YOU-ARE-AN-AI.md: missing required Stage 4-7 assertion '${required}'`);
}

if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
