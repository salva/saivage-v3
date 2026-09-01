import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const fs = require('node:fs') as typeof import('node:fs');
const input = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as { root: string };
const root = resolve(input.root);

const ledgers = new Map<string, { opens: number }>();
const descriptors = new Set<number>();
const bump = (path: string): void => {
  const ledger = ledgers.get(path) ?? { opens: 0 };
  ledger.opens += 1;
  ledgers.set(path, ledger);
};

const originalOpen = fs.openSync;
const originalReadFileSync = fs.readFileSync;
const originalClose = fs.closeSync;
fs.openSync = ((path: Parameters<typeof fs.openSync>[0], ...args: unknown[]) => {
  const exact = String(path);
  if (exact.startsWith(root)) bump(exact);
  const descriptor = Reflect.apply(originalOpen, fs, [path, ...args]) as number;
  if (exact.startsWith(root)) descriptors.add(descriptor);
  return descriptor;
}) as typeof fs.openSync;
fs.readFileSync = ((path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
  const result = Reflect.apply(originalReadFileSync, fs, [path, ...args]);
  const exact = String(path);
  if (exact.startsWith(root)) bump(exact);
  return result;
}) as typeof fs.readFileSync;
fs.closeSync = ((descriptor: number) => {
  try { return originalClose(descriptor); }
  finally { descriptors.delete(descriptor); }
}) as typeof fs.closeSync;
syncBuiltinESMExports();

const { AgentOperatorReadModelService } = await import('../../src/application/read-models/agent-operator-read-model.js');
const { TEST_WORKFLOWS } = await import('../helpers/canonical-project.js');
new AgentOperatorReadModelService(root, TEST_WORKFLOWS, () => new Set()).listSessions();

const snapshot = { cardStreamOpens: {} as Record<string, number>, conversationIndexOpens: 0, conversationSegmentOpens: 0 };
for (const [path, ledger] of ledgers) {
  const segments = path.split(sep);
  if (path.endsWith(`${sep}card.jsonl`)) snapshot.cardStreamOpens[path] = ledger.opens;
  else if (segments.includes('conversations')) {
    if (basename(path) === 'index.json') snapshot.conversationIndexOpens += ledger.opens;
    else if (segments.includes('versions')) snapshot.conversationSegmentOpens += ledger.opens;
  }
}
process.stdout.write(`${JSON.stringify(snapshot)}\n`);
