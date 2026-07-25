import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type MutableFs = typeof import('node:fs');
type CandidateLedger = {
  openAttempts: number;
  readCalls: number;
  bytesRead: number;
  closes: number;
};

const require = createRequire(import.meta.url);
const fs = require('node:fs') as MutableFs;
const root = fs.mkdtempSync(join(tmpdir(), 'saivage-conversation-read-ledger-'));
const scenario = process.argv[2];

try {
  const paths = createFixture(root, scenario);
  const expectedFirstEnvelopeBytes = firstEnvelopeBytes(paths);
  const ledger = new Map<string, CandidateLedger>(
    Object.values(paths).map((path) => [
      path,
      { openAttempts: 0, readCalls: 0, bytesRead: 0, closes: 0 },
    ]),
  );
  const descriptors = new Map<number, string>();
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalCloseSync = fs.closeSync;

  fs.openSync = ((path: Parameters<typeof fs.openSync>[0], ...args: unknown[]) => {
    const exactPath = String(path);
    const record = ledger.get(exactPath);
    if (record) record.openAttempts += 1;
    const descriptor = Reflect.apply(originalOpenSync, fs, [path, ...args]) as number;
    if (record) descriptors.set(descriptor, exactPath);
    return descriptor;
  }) as typeof fs.openSync;
  fs.readSync = ((descriptor: number, ...args: unknown[]) => {
    const count = Reflect.apply(originalReadSync, fs, [descriptor, ...args]) as number;
    const exactPath = descriptors.get(descriptor);
    if (exactPath) {
      const record = ledger.get(exactPath)!;
      record.readCalls += 1;
      record.bytesRead += count;
    }
    return count;
  }) as typeof fs.readSync;
  fs.closeSync = ((descriptor: number) => {
    const exactPath = descriptors.get(descriptor);
    try {
      return originalCloseSync(descriptor);
    } finally {
      if (exactPath) {
        ledger.get(exactPath)!.closes += 1;
        descriptors.delete(descriptor);
      }
    }
  }) as typeof fs.closeSync;
  syncBuiltinESMExports();

  const { AgentOperatorReadModelService } =
    await import('../../src/application/read-models/agent-operator-read-model.js');
  const { TEST_WORKFLOWS } = await import('../helpers/canonical-project.js');
  let sessions: unknown = null;
  let error: string | null = null;
  try {
    sessions = new AgentOperatorReadModelService(root, TEST_WORKFLOWS).listSessions().sessions;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  process.stdout.write(
    `${JSON.stringify({
      scenario,
      paths,
      ledger: Object.fromEntries(ledger),
      firstEnvelopeBytes: expectedFirstEnvelopeBytes,
      sessions,
      error,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function createFixture(projectRoot: string, fixtureScenario: string | undefined) {
  if (!['valid', 'malformed-first', 'malformed-later'].includes(fixtureScenario ?? '')) {
    throw new Error(`Unknown fixture scenario '${fixtureScenario}'.`);
  }
  const stamp = '2026-07-21T00:00:00.000Z';
  const saivage = join(projectRoot, '.saivage');
  const cardRoot = join(saivage, 'cards', 'project');
  const conversations = join(cardRoot, 'conversations');
  const analyst = join(saivage, 'agents', 'conversations', 'analyst.jsonl');
  const planner = join(conversations, 'planner.jsonl');
  const reviewer = join(conversations, 'reviewer.jsonl');
  const app = join(saivage, 'logs', 'app.jsonl');
  fs.mkdirSync(conversations, { recursive: true });
  fs.mkdirSync(join(saivage, 'agents', 'conversations'), { recursive: true });
  const card = {
    id: 'project',
    type: 'project',
    children: [],
    title: 'Read ledger project',
    subtype: null,
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'runtime:bootstrap',
    created_at: stamp,
    updated_at: stamp,
    version_seq: 1,
    assigned_to: null,
    depends_on: [],
    related: [],
    metrics: null,
    estimate: null,
    started_at: null,
    duration_ms: null,
    status_text: null,
    status_text_updated_at: null,
    status_text_author_session_id: null,
    latest_self_report: null,
    metadata: null,
    pending_notifications: [],
  };
  writeEnvelope(join(cardRoot, 'card.jsonl'), [
    {
      kind: 'card-version',
      format_version: 2,
      card_id: 'project',
      version: 1,
      committed_at: stamp,
      card,
      history: null,
    },
  ]);

  if (fixtureScenario === 'malformed-first') {
    fs.writeFileSync(planner, '{malformed first envelope}\n');
  } else {
    writeEnvelope(planner, [marker('agent:planner:project', 'planner', stamp)]);
    writeEnvelope(reviewer, [marker('agent:reviewer:project', 'reviewer', stamp)]);
    if (fixtureScenario === 'malformed-later') {
      fs.appendFileSync(planner, '{malformed later envelope}\n');
    } else {
      fs.appendFileSync(
        planner,
        `${JSON.stringify({
          version: 1,
          type: 'rows',
          rows: [text('agent:planner:project', 'later', stamp)],
        })}\n`,
      );
    }
  }
  fs.mkdirSync(join(saivage, 'logs'), { recursive: true });
  fs.writeFileSync(app, '{malformed app log}\n');
  return { analyst, planner, reviewer, app };
}

function marker(session_id: string, agent_name: string, timestamp: string) {
  return {
    id: `${agent_name}-marker`,
    session_id,
    role: 'system',
    kind: 'activity',
    content: JSON.stringify({
      agent_name,
      card_id: 'project',
      event: 'activation_open',
      input_id: '00000000-0000-4000-8000-000000000001',
      timestamp,
    }),
    round_id: `r-user-${'0'.repeat(32)}`,
    message_index: 0,
    block_index: 0,
    timestamp,
  };
}

function text(session_id: string, id: string, timestamp: string) {
  return {
    id,
    session_id,
    role: 'assistant',
    kind: 'text',
    content: id,
    round_id: `r-assistant-${'1'.repeat(32)}`,
    message_index: 1,
    block_index: 0,
    timestamp,
  };
}

function writeEnvelope(path: string, rows: readonly unknown[]): void {
  fs.writeFileSync(path, `${JSON.stringify({ version: 1, type: 'rows', rows })}\n`);
}

function firstEnvelopeBytes(paths: Record<string, string>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(paths).map(([key, path]) => {
      if (!fs.existsSync(path)) return [key, 0];
      const bytes = fs.readFileSync(path);
      const newline = bytes.indexOf(0x0a);
      return [key, newline < 0 ? bytes.byteLength : newline + 1];
    }),
  );
}
