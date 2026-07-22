import { createRequire } from 'node:module';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type MutableFs = typeof import('node:fs');
type CandidateLedger = { openAttempts: number; descriptorReads: number; pathReads: number; closes: number };

const require = createRequire(import.meta.url);
const fs = require('node:fs') as MutableFs;
const root = fs.mkdtempSync(join(tmpdir(), 'saivage-conversation-read-ledger-'));
const scenario = process.argv[2];

try {
  const paths = createFixture(root, scenario);
  const candidates = new Set(Object.values(paths));
  const ledger = new Map<string, CandidateLedger>([...candidates].map((path) => [path, { openAttempts: 0, descriptorReads: 0, pathReads: 0, closes: 0 }]));
  const descriptors = new Map<number, string>();
  const originalOpenSync = fs.openSync;
  const originalReadFileSync = fs.readFileSync;
  const originalCloseSync = fs.closeSync;

  fs.openSync = ((path: Parameters<typeof fs.openSync>[0], ...args: unknown[]) => {
    const exactPath = String(path);
    const record = ledger.get(exactPath);
    if (record) record.openAttempts += 1;
    const descriptor = Reflect.apply(originalOpenSync, fs, [path, ...args]) as number;
    if (record) descriptors.set(descriptor, exactPath);
    return descriptor;
  }) as typeof fs.openSync;
  fs.readFileSync = ((path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
    if (typeof path === 'number') {
      const exactPath = descriptors.get(path);
      if (exactPath) ledger.get(exactPath)!.descriptorReads += 1;
    } else {
      const record = ledger.get(String(path));
      if (record) record.pathReads += 1;
    }
    return Reflect.apply(originalReadFileSync, fs, [path, ...args]);
  }) as typeof fs.readFileSync;
  fs.closeSync = ((descriptor: number) => {
    const exactPath = descriptors.get(descriptor);
    try { return originalCloseSync(descriptor); }
    finally {
      if (exactPath) {
        ledger.get(exactPath)!.closes += 1;
        descriptors.delete(descriptor);
      }
    }
  }) as typeof fs.closeSync;
  syncBuiltinESMExports();

  await import('../../src/persistence/conversation-file.js');
  const { AgentOperatorReadModelService } = await import('../../src/application/read-models/agent-operator-read-model.js');
  const { TEST_WORKFLOWS } = await import('../helpers/canonical-project.js');
  let sessions: unknown = null;
  let error: string | null = null;
  const live = scenario === 'empty-live-malformed'
    ? [{ sessionId: 'agent:planner:project', agentId: 'agent:planner:project', agentName: 'planner', cardId: 'project', activity: { mode: 'active', barrier: null } } as const]
    : [];
  try { sessions = new AgentOperatorReadModelService(root, () => live, TEST_WORKFLOWS).listSessions().sessions; }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }

  process.stdout.write(`${JSON.stringify({ scenario, paths, ledger: Object.fromEntries(ledger), sessions, error })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function createFixture(projectRoot: string, fixtureScenario: string | undefined) {
  if (!['valid', 'malformed', 'empty-malformed', 'empty-live-malformed', 'models', 'models-malformed'].includes(fixtureScenario ?? '')) throw new Error(`Unknown fixture scenario '${fixtureScenario}'.`);
  const scenario = fixtureScenario!;
  const stamp = '2026-07-21T00:00:00.000Z';
  const saivage = join(projectRoot, '.saivage');
  const cardRoot = join(saivage, 'cards', 'project');
  const cardConversations = join(cardRoot, 'conversations');
  const analyst = join(saivage, 'agents', 'conversations', 'analyst.jsonl');
  const planner = join(cardConversations, 'planner.jsonl');
  const reviewer = join(cardConversations, 'reviewer.jsonl');
  const app = join(saivage, 'logs', 'app.jsonl');
  fs.mkdirSync(cardConversations, { recursive: true });
  fs.mkdirSync(join(saivage, 'agents', 'conversations'), { recursive: true });
  const card = {
    id: 'project', type: 'project', children: [], title: 'Read ledger project', subtype: null, lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    tags: [], priority: 0, urgency: 'normal', created_by: 'runtime:bootstrap', created_at: stamp, updated_at: stamp, version_seq: 1,
    assigned_to: null, depends_on: [], related: [], metrics: null, estimate: null, started_at: null, duration_ms: null,
    status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null, pending_notifications: [],
  };
  writeEnvelope(join(cardRoot, 'card.jsonl'), [{ kind: 'card-version', format_version: 2, card_id: 'project', version: 1, committed_at: stamp, card, history: null }]);

  if (scenario === 'malformed') {
    fs.writeFileSync(planner, '{"version":1,"type":"rows","rows":[{"invalid":true}]}\n');
  } else if (!scenario.startsWith('empty-')) {
    writeEnvelope(planner, [message('agent:planner:project', 'planner-one', stamp, 0)]);
    writeEnvelope(reviewer, [message('agent:reviewer:project', 'reviewer-one', stamp, 0)]);
    appendEnvelope(reviewer, [message('agent:reviewer:project', 'reviewer-two', '2026-07-21T00:00:01.000Z', 1)]);
  }
  if (scenario.endsWith('malformed')) {
    fs.mkdirSync(join(saivage, 'logs'), { recursive: true });
    fs.writeFileSync(app, '{"version":1,"type":"rows","rows":[{"invalid":true}]}\n');
  } else if (scenario === 'models') {
    fs.mkdirSync(join(saivage, 'logs'), { recursive: true });
    writeEnvelope(app, [providerExchange('agent:planner:project', 'planner-model', stamp, 0), providerExchange('agent:reviewer:project', 'reviewer-model', stamp, 0)]);
  }
  return { analyst, planner, reviewer, app };
}

function message(session_id: 'agent:planner:project' | 'agent:reviewer:project', id: string, timestamp: string, message_index: number) {
  return { id, session_id, role: 'user', kind: 'text', content: id, round_id: 'r-user-00000000000000000000000000000000', message_index, block_index: 0, timestamp };
}

function providerExchange(session_id: string, model: string, timestamp: string, attempt_index: number) {
  const source_input_id = `${session_id}-input`;
  return {
    type: 'provider_exchange',
    data: {
      session_id, source_input_id, attempt_index, timestamp,
      payload: {
        contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model,
        source_input_id, attempt_index, request_params: {}, started_at: timestamp, completed_at: timestamp,
        status: 'ok', terminal_tool_fired: null, assistant_output_ids: [],
      },
    },
  };
}

function writeEnvelope(path: string, rows: readonly unknown[]): void {
  fs.writeFileSync(path, `${JSON.stringify({ version: 1, type: 'rows', rows })}\n`);
}

function appendEnvelope(path: string, rows: readonly unknown[]): void {
  fs.appendFileSync(path, `${JSON.stringify({ version: 1, type: 'rows', rows })}\n`);
}
