import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

type MutableFs = typeof import('node:fs');
type Ledger = { openAttempts: number; readCalls: number; bytesRead: number; closes: number };
type Measurement = {
  elapsedMs: number;
  cpuMs: number;
  candidateOpens: number;
  candidateCloses: number;
  candidateBytes: number;
  candidatePathsReadOnce: boolean;
  appLogOpens: number;
  snapshotOpens: number;
};

const require = createRequire(import.meta.url);
const fs = require('node:fs') as MutableFs;
const input = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as {
  root: string;
  candidatePaths: string[];
  appPath: string;
  measuredCardId: string;
  runs: number;
};
const candidatePaths = new Set(input.candidatePaths);
const ledgers = new Map([...candidatePaths, input.appPath].map((path) => [path, zeroLedger()]));
const descriptors = new Map<number, string>();
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalClose = fs.closeSync;
let snapshotOpens = 0;

fs.openSync = ((path: Parameters<typeof fs.openSync>[0], ...args: unknown[]) => {
  const exact = String(path);
  if (exact.startsWith(join(input.root, '.saivage', 'runtime'))) snapshotOpens += 1;
  const ledger = ledgers.get(exact);
  if (ledger) ledger.openAttempts += 1;
  const descriptor = Reflect.apply(originalOpen, fs, [path, ...args]) as number;
  if (ledger) descriptors.set(descriptor, exact);
  return descriptor;
}) as typeof fs.openSync;
fs.readSync = ((descriptor: number, ...args: unknown[]) => {
  const bytes = Reflect.apply(originalRead, fs, [descriptor, ...args]) as number;
  const path = descriptors.get(descriptor);
  if (path) { const ledger = ledgers.get(path)!; ledger.readCalls += 1; ledger.bytesRead += bytes; }
  return bytes;
}) as typeof fs.readSync;
fs.closeSync = ((descriptor: number) => {
  const path = descriptors.get(descriptor);
  try { return originalClose(descriptor); }
  finally { if (path) { ledgers.get(path)!.closes += 1; descriptors.delete(descriptor); } }
}) as typeof fs.closeSync;
syncBuiltinESMExports();

const { AgentOperatorReadModelService } = await import('../../src/application/read-models/agent-operator-read-model.js');
const { TEST_WORKFLOWS } = await import('../helpers/canonical-project.js');
const service = () => new AgentOperatorReadModelService(input.root, TEST_WORKFLOWS);

service().listSessions();
reset();
const globalRuns: Measurement[] = [];
for (let index = 0; index < input.runs; index++) globalRuns.push(measure(() => service().listSessions()));
reset();
const cardScope = measure(() => service().listCardSessions(input.measuredCardId as never));
process.stdout.write(`${JSON.stringify({ globalRuns, cardScope, cardScopeLedgers: Object.fromEntries(ledgers) })}\n`);

function measure(operation: () => unknown): Measurement {
  reset();
  const cpu = process.cpuUsage();
  const started = performance.now();
  operation();
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  let candidateOpens = 0;
  let candidateCloses = 0;
  let candidateBytes = 0;
  let candidatePathsReadOnce = true;
  for (const [path, ledger] of ledgers) {
    if (path === input.appPath) continue;
    candidateOpens += ledger.openAttempts;
    candidateCloses += ledger.closes;
    candidateBytes += ledger.bytesRead;
    candidatePathsReadOnce &&= ledger.openAttempts === 0 || (ledger.openAttempts === 1 && ledger.closes === 1);
  }
  return {
    elapsedMs,
    cpuMs: (used.user + used.system) / 1000,
    candidateOpens,
    candidateCloses,
    candidateBytes,
    candidatePathsReadOnce,
    appLogOpens: ledgers.get(input.appPath)!.openAttempts,
    snapshotOpens,
  };
}

function reset(): void {
  for (const ledger of ledgers.values()) Object.assign(ledger, zeroLedger());
  snapshotOpens = 0;
}
function zeroLedger(): Ledger { return { openAttempts: 0, readCalls: 0, bytesRead: 0, closes: 0 }; }
