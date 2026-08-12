import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const paths = [...new Set([...tracked, ...untracked])];
const violations = [];

const sourceForbidden = [
  /cardRecordStreamFile/u,
  /latestClosedRecordEntry/u,
  /readRecord\([^)]*['"](?:latest|open)['"]/u,
  /record:\/\/\/[^\s'"`]*[?&]v=next/u,
  /\bWebfetchWriteSchema\b/u,
  /\btarget_url\b/u,
  /\blist_card_history\b|\bget_card_history_entry\b|\bdiff_card\b/u,
  /\breadBoundedConversation\b/u,
  /\bthrough_message_id\b/u,
];

const canonicalDocs = new Set(['README.md', 'README-IF-YOU-ARE-AN-AI.md', 'docs/spec/system-specification.md', 'docs/spec/operator-ui.md', 'docs/architecture/system-architecture.md', 'docs/architecture/index.md', 'docs/runbook/index.md']);
const staleCanonical = [
  /canonical card state lives in `card\.jsonl`/iu,
  /virtual `?card\.jsonl`/iu,
  /required `card\.jsonl`/iu,
  /embedded snapshots in `card\.jsonl`/iu,
  /exact latest[- ]closed/iu,
  /one exact latest[- ]closed/iu,
  /six ordered phases/iu,
  /accept(?:s|ed|ing)? a (?:strictly )?valid existing project card/iu,
];

for (const path of paths) {
  if (!existsSync(path) || path.startsWith('docs-old/') || path.startsWith('docs/working/') || path === 'scripts/check-canonical-persistence-drift.js') continue;
  if (!path.startsWith('src/') && !path.startsWith('docs/spec/') && !path.startsWith('docs/architecture/') && !path.startsWith('docs/runbook/') && path !== 'README.md' && path !== 'README-IF-YOU-ARE-AN-AI.md') continue;
  const content = readFileSync(path, 'utf8');
  if (path.startsWith('src/')) {
    for (const pattern of sourceForbidden) if (pattern.test(content)) violations.push(`${path}: forbidden obsolete persistence or model-tool contract`);
    if ((path === 'src/persistence/card-files.ts' || path === 'src/persistence/authored-record-files.ts') && /readdirSync|opendir|scandir/u.test(content)) violations.push(`${path}: canonical version discovery is forbidden`);
    continue;
  }
  if (canonicalDocs.has(path)) for (const pattern of staleCanonical) if (pattern.test(content)) violations.push(`${path}: stale stream-era canonical contract`);
  for (const [offset, line] of content.split('\n').entries()) {
    const lower = line.toLowerCase();
    const explicitlyRejected = /\b(?:no|not|never|unsupported|reject(?:ed|s)?|remove(?:d|s)?|without)\b/u.test(lower);
    if (!explicitlyRejected && (/latest[- ]closed/u.test(lower) || /record:\/\/\/[^\s`]*[?&]v=next/u.test(lower) || /\blist_card_history\b|\bget_card_history_entry\b|\bdiff_card\b/u.test(line))) violations.push(`${path}:${offset + 1}: stale current-authority contract`);
  }
}

const guide = readFileSync('README-IF-YOU-ARE-AN-AI.md', 'utf8');
for (const required of ['## Stage 4 — Initialize and configure', '## Stage 5 — Confine access, install, and start', '## Stage 6 — Verify and teach first use', '## Stage 7 — Hand off and present later options', 'strict empty', 'whole-current-graph validation', 'card.json', 'expected_head', 'no live lifecycle owner', 'four generated roots wholesale']) {
  if (!guide.includes(required)) violations.push(`README-IF-YOU-ARE-AN-AI.md: missing required Stage 4-7 assertion '${required}'`);
}

if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
