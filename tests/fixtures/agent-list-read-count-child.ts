import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const fs = require('node:fs') as typeof import('node:fs');
const input = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as { root: string };
const root = resolve(input.root);

type ReadLedger = { opens: number; readCalls: number; readFileCalls: number };

const ledgers = new Map<string, ReadLedger>();
const descriptors = new Map<number, string>();
const ledgerFor = (path: string): ReadLedger => {
  const ledger = ledgers.get(path) ?? { opens: 0, readCalls: 0, readFileCalls: 0 };
  ledgers.set(path, ledger);
  return ledger;
};

const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalReadFileSync = fs.readFileSync;
const originalClose = fs.closeSync;
fs.openSync = ((path: Parameters<typeof fs.openSync>[0], ...args: unknown[]) => {
  const exact = String(path);
  if (exact.startsWith(root)) ledgerFor(exact).opens += 1;
  const descriptor = Reflect.apply(originalOpen, fs, [path, ...args]) as number;
  if (exact.startsWith(root)) descriptors.set(descriptor, exact);
  return descriptor;
}) as typeof fs.openSync;
fs.readSync = ((descriptor: number, ...args: unknown[]) => {
  const path = descriptors.get(descriptor);
  if (path) ledgerFor(path).readCalls += 1;
  return Reflect.apply(originalRead, fs, [descriptor, ...args]) as number;
}) as typeof fs.readSync;
fs.readFileSync = ((path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
  const exact = String(path);
  if (exact.startsWith(root)) ledgerFor(exact).readFileCalls += 1;
  return Reflect.apply(originalReadFileSync, fs, [path, ...args]);
}) as typeof fs.readFileSync;
fs.closeSync = ((descriptor: number) => {
  try { return originalClose(descriptor); }
  finally { descriptors.delete(descriptor); }
}) as typeof fs.closeSync;
syncBuiltinESMExports();

const { AgentOperatorReadModelService } = await import('../../src/application/read-models/agent-operator-read-model.js');
const { TEST_WORKFLOWS } = await import('../helpers/canonical-project.js');
new AgentOperatorReadModelService(root, TEST_WORKFLOWS, () => new Map()).listSessions();

const snapshot = {
  cardStreamOpens: {} as Record<string, number>,
  conversationIndexReads: {} as Record<string, ReadLedger>,
  conversationSegmentOpens: 0,
};
for (const [path, ledger] of ledgers) {
  const segments = path.split(sep);
  if (path.endsWith(`${sep}card.jsonl`)) snapshot.cardStreamOpens[path] = ledger.opens;
  else if (segments.includes('conversations')) {
    if (basename(path) === 'index.json') snapshot.conversationIndexReads[path] = { ...ledger };
    else if (segments.includes('versions')) snapshot.conversationSegmentOpens += ledger.opens + ledger.readFileCalls;
  }
}
process.stdout.write(`${JSON.stringify(snapshot)}\n`);
