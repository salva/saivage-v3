import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = [
  ['global', 'seq'].join(''),
  ['allocate', 'global', 'record', 'seq'].join(''),
  ['next', 'global', 'record', 'seq'].join(''),
  ['.saivage/cards/', 'index.json'].join(''),
  ['open', 'record', 'slot'].join(''),
  ['close', 'open', 'record', 'slot'].join(''),
  ['discard', 'open', 'record', 'slot'].join(''),
  ['test-record-', 'bodies'].join(''),
  ['card', '/versions/'].join(''),
  ['brief', '/versions/'].join(''),
  ['status', '/versions/'].join(''),
  ['review', '/versions/'].join(''),
  ['tombstone', '.json'].join(''),
  ['scan', 'card', 'index'].join(''),
];
const violations = [];
for (const path of tracked) {
  if (path === 'scripts/check-canonical-persistence-drift.js') continue;
  if (path.startsWith('docs-old/')) continue;
  if (!path.startsWith('src/') && !path.startsWith('tests/') && !path.startsWith('docs/spec/') && !path.startsWith('docs/architecture/') && path !== 'README.md' && path !== 'AGENTS.md') continue;
  if (!existsSync(path)) continue;
  const content = readFileSync(path).toString('utf8').toLowerCase();
  for (const token of forbidden) if (content.includes(token)) violations.push(`${path}: forbidden persistence contract token`);
  if ((path === 'src/persistence/card-files.ts' || path === 'src/persistence/conversation-file.ts') && /readdirsync|opendir|scandir/u.test(content)) violations.push(`${path}: canonical card/session discovery is forbidden`);
  if (path.startsWith('src/') && /card-index-scan|tombstone\.json|\/versions\//u.test(content)) violations.push(`${path}: obsolete card/version/tombstone layout is forbidden`);
  if (path === 'src/runtime/actors/conversation-inventory.ts' && /conversationdir|conversation\.jsonl/u.test(content)) violations.push(`${path}: per-session conversation directories are forbidden`);
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
