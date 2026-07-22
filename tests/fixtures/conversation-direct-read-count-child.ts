import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type MutableFs = typeof import('node:fs');

const require = createRequire(import.meta.url);
const fs = require('node:fs') as MutableFs;
const root = fs.mkdtempSync(join(tmpdir(), 'saivage-direct-conversation-read-'));
const operation = process.argv[2];
const path = join(root, '.saivage', 'cards', 'project', 'conversations', 'planner.jsonl');

try {
  if (operation !== 'detail' && operation !== 'conversation') throw new Error(`Unknown operation '${operation}'.`);
  fs.mkdirSync(join(path, '..'), { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify({ version: 1, type: 'rows', rows: [{ id: 'message', session_id: 'agent:planner:project', role: 'user', kind: 'text', content: 'hello', round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-22T00:00:00.000Z' }] })}\n`);

  const ledger = { openAttempts: 0, descriptorReads: 0, pathReads: 0, closes: 0 };
  const descriptors = new Set<number>();
  const originalOpenSync = fs.openSync;
  const originalReadFileSync = fs.readFileSync;
  const originalCloseSync = fs.closeSync;
  fs.openSync = ((candidate: Parameters<typeof fs.openSync>[0], ...args: unknown[]) => {
    if (String(candidate) === path) ledger.openAttempts += 1;
    const descriptor = Reflect.apply(originalOpenSync, fs, [candidate, ...args]) as number;
    if (String(candidate) === path) descriptors.add(descriptor);
    return descriptor;
  }) as typeof fs.openSync;
  fs.readFileSync = ((candidate: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
    if (typeof candidate === 'number' && descriptors.has(candidate)) ledger.descriptorReads += 1;
    else if (String(candidate) === path) ledger.pathReads += 1;
    return Reflect.apply(originalReadFileSync, fs, [candidate, ...args]);
  }) as typeof fs.readFileSync;
  fs.closeSync = ((descriptor: number) => {
    if (descriptors.has(descriptor)) ledger.closes += 1;
    try { return originalCloseSync(descriptor); }
    finally { descriptors.delete(descriptor); }
  }) as typeof fs.closeSync;
  syncBuiltinESMExports();

  const { AgentOperatorReadModelService } = await import('../../src/application/read-models/agent-operator-read-model.js');
  const { TEST_WORKFLOWS } = await import('../helpers/canonical-project.js');
  const service = new AgentOperatorReadModelService(root, () => [], TEST_WORKFLOWS);
  const result = operation === 'detail' ? service.getSession('agent:planner:project') : service.getConversation('agent:planner:project');
  process.stdout.write(`${JSON.stringify({ ...ledger, statusCode: result.statusCode ?? 200 })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
