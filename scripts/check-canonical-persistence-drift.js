import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = [
  ['global', 'seq'].join(''),
  ['allocate', 'global', 'record', 'seq'].join(''),
  ['next', 'global', 'record', 'seq'].join(''),
  ['.saivage/cards/', 'index.json'].join(''),
];
const violations = [];
for (const path of tracked) {
  if (path === 'scripts/check-canonical-persistence-drift.js') continue;
  if (path.startsWith('docs-old/')) continue;
  if (!existsSync(path)) continue;
  const content = readFileSync(path).toString('utf8').toLowerCase();
  for (const token of forbidden) if (content.includes(token)) violations.push(`${path}: forbidden persistence contract token`);
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
