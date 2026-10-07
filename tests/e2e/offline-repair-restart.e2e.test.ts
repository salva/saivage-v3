import { afterEach, expect, it, jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../../src/boot/app.js';
import { CardService } from '../../src/cards/card-service.js';
import {
  compileProjectWorkflows,
  cardProcessEntryForStatus,
} from '../../src/runtime/card-process/card-process-config.js';
import {
  appendConversationBatch,
  readCurrentConversationSegment,
} from '../../src/persistence/conversation-file.js';
import {
  cardHeadFile,
  cardPreviousHeadFile,
  cardRecordHeadFile,
  cardRecordPreviousHeadFile,
  cardConversationVersionFile,
  cardConversationVersionIndexFile,
  globalAgentConversationVersionIndexFile,
  appLogFile,
} from '../../src/persistence/layout.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import { compact, prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';
import {
  appOrigin,
  closeServer,
  createServer,
  initializeProject,
  listen,
  offeredToolNames,
  postStartProject,
  productionTestConfig,
  readJsonRequest,
  sendFinalMessage,
  sendToolCall,
  startProductionApp,
  waitFor,
  writeProductionConfig,
} from '../helpers/production-composition-e2e.js';

const TOKEN = 'offline-repair-test-token';
const CLI = join(process.cwd(), 'src/cli.ts');
const TSX = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
const roots: string[] = [];
const apps = new Set<App>();
afterEach(async () => {
  for (const app of apps) await app.stop();
  apps.clear();
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function fixture(port: number, customize?: Parameters<typeof productionTestConfig>[1]) {
  const outside = mkdtempSync(join(tmpdir(), 'repair-restart-'));
  roots.push(outside);
  const root = join(outside, 'project');
  const config = productionTestConfig(port, customize);
  writeProductionConfig(root, config);
  initializeProject(root);
  return {
    outside,
    root,
    cards: new CardService(root, compileProjectWorkflows(config, { projectRoot: root })),
  };
}
function breakHeads(root: string, id: string) {
  for (const path of [cardHeadFile(root, id), cardPreviousHeadFile(root, id)]) {
    if (existsSync(path)) unlinkSync(path);
    writeFileSync(path, 'broken selector');
  }
}
function snapshot(paths: string[]) {
  return paths.map((path) => ({ path, bytes: readFileSync(path) }));
}
function unchanged(rows: ReturnType<typeof snapshot>) {
  for (const row of rows) expect(readFileSync(row.path)).toEqual(row.bytes);
}
function brief(cards: CardService, id: string) {
  const result = cards.readRecordCurrent(id, 'brief.md');
  if (result.kind !== 'found') throw new Error('Missing placeholder brief');
  return result.value.projection;
}
async function ready(root: string, counter: () => number) {
  const before = counter();
  const app = await startProductionApp(root, TOKEN);
  apps.add(app);
  expect((await fetch(`${appOrigin(app)}/health/ready`)).status).toBe(200);
  expect(counter()).toBe(before);
  return app;
}
// util-linux script supplies a real PTY: production readline and isTTY run unchanged.
async function repair(
  f: { outside: string; root: string },
  target: string,
  options: string[] = [],
  refuse = false,
) {
  const id = randomUUID();
  const backup = join(f.outside, `backup-${id}`);
  cpSync(f.root, backup, { recursive: true });
  const report = join(f.outside, `report-${id}.md`);
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const command = [
    process.execPath,
    TSX,
    CLI,
    'repair',
    '--target',
    target,
    '--backup',
    backup,
    '--report',
    report,
    ...options,
  ]
    .map(quote)
    .join(' ');
  const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
    cwd: f.root,
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let phase = 0;
  let failure: Error | undefined;
  const onData = (data: Buffer) => {
    output += data.toString();
    try {
      if (phase === 0 && output.includes('before inspection: ')) {
        phase = 1;
        child.stdin.write(`BACKUP COMPLETE ${target}\n`);
      }
      if (phase === 1 && output.includes('consent to exactly these effects: ')) {
        expect(existsSync(report)).toBe(true);
        expect(readFileSync(report, 'utf8')).toContain('Proposed');
        phase = 2;
        child.stdin.write(refuse ? 'NO\n' : `REPAIR ${target}\n`);
      }
      if (phase === 2 && output.includes('descendant-reachability loss: ')) {
        phase = 3;
        child.stdin.write(`DISCARD CARD ${target}\n`);
      }
    } catch (error) {
      failure = error as Error;
      child.kill('SIGKILL');
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Repair PTY timed out: ${output}`));
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (failure) throw failure;
  return { code, report, output };
}
function create(cards: CardService, type = 'code', parent = 'project', depends_on: string[] = []) {
  return cards.create({
    type,
    parent,
    title: 'Original card',
    bootstrap_content: 'Original requirements',
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    depends_on,
  });
}
it('spawned prev repairs fresh-publish identities and disclose pending/draft loss, then restart without provider work', async () => {
  let calls = 0;
  const provider = createServer((_req, res) => {
    calls++;
    res.statusCode = 500;
    res.end();
  });
  const port = await listen(provider);
  try {
    const f = fixture(port);
    const child = create(f.cards);
    f.cards.enqueueNotification(child.id, {
      id: randomUUID(),
      content: 'Latest pending context',
      created_at: new Date().toISOString(),
    });
    const previous = JSON.parse(readFileSync(cardPreviousHeadFile(f.root, child.id), 'utf8'));
    unlinkSync(cardHeadFile(f.root, child.id));
    const cardRepair = await repair(f, `card:${child.id}`);
    expect(cardRepair.code).toBe(0);
    const restored = JSON.parse(readFileSync(cardHeadFile(f.root, child.id), 'utf8'));
    expect(restored.head_id).not.toBe(previous.head_id);
    expect(restored.pending).toEqual(previous.pending);
    expect(f.cards.readPendingNotifications(child.id)).toEqual([]);
    expect(readFileSync(cardRepair.report, 'utf8')).toContain('queue changes may be lost');
    f.cards.openRecord(child.id, 'brief.md');
    f.cards.editRecord(child.id, 'brief.md', 'first draft');
    f.cards.editRecord(child.id, 'brief.md', 'latest lost draft');
    const definition = {
      filename: 'brief.md',
      format: 'markdown' as const,
      schema: 'card-brief.v1',
      bootstrap: true,
      declared: true,
    };
    const recordHead = cardRecordHeadFile(f.root, child.id, definition);
    const old = JSON.parse(
      readFileSync(cardRecordPreviousHeadFile(f.root, child.id, definition), 'utf8'),
    );
    unlinkSync(recordHead);
    writeFileSync(recordHead, 'bad record head');
    const recordRepair = await repair(f, `record:${child.id}/brief.md`);
    expect(recordRepair.code).toBe(0);
    expect(JSON.parse(readFileSync(recordHead, 'utf8')).head_id).not.toBe(old.head_id);
    expect(f.cards.readRecordCurrent(child.id, 'brief.md')).toMatchObject({
      kind: 'found',
      value: { projection: { draft: { content: 'first draft' } } },
    });
    expect(readFileSync(recordRepair.report, 'utf8')).toContain('draft changes may be lost');
    await ready(f.root, () => calls);
    expect(calls).toBe(0);
  } finally {
    await closeServer(provider);
  }
}, 60_000);

const SESSION = 'agent:planner:project' as const;
async function compactFixture(root: string) {
  for (let n = 1; n <= 7; n++) {
    const stamp = `2026-10-04T00:0${n}:00.000Z`;
    appendConversationBatch({ projectRoot: root }, [
      {
        id: `activation-${n}`,
        session_id: SESSION,
        role: 'system',
        kind: 'activity',
        context_policy: ACTIVITY_ROW_POLICY,
        content: JSON.stringify({
          event: 'activation_open',
          agent_name: 'planner',
          card_id: 'project',
          input_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
          timestamp: stamp,
        }),
        round_id: `r-pre-${String(n).padStart(32, '0')}`,
        message_index: 0,
        block_index: 0,
        timestamp: stamp,
      },
      {
        id: `message-${n}`,
        session_id: SESSION,
        role: 'user',
        kind: 'text',
        context_policy: TEXT_ROW_POLICY,
        content: 'x'.repeat(400),
        round_id: `r-user-${String(n).padStart(32, '0')}`,
        message_index: 1,
        block_index: 0,
        timestamp: stamp,
      },
    ]);
  }
  const before = readCurrentConversationSegment(root, SESSION)!;
  const candidate = { provider: 'test', account: null, model: 'test' } as const;
  const preparedCompaction = prepareCompaction(
    {
      context_utilization_fraction: 0.8,
      trigger_fraction: 0.8,
      tail_fraction: 0.25,
      snap: 'compact_straddler',
    },
    'system',
    [],
    8000,
    2000,
  );
  const result = await compact({
    strategy: 'preventive',
    conversations: { projectRoot: root },
    input: {
      inputId: randomUUID(),
      agentId: SESSION,
      agentName: 'planner',
      sessionId: SESSION,
      systemPrompt: 'system',
      providerConversation: providerConversationProjection(before.conversation, []),
      tools: [],
      compiledToolContracts: [],
      terminalToolNames: [],
      modelParams: { temperature: 0 },
      preparedCompaction,
      preparedContext: buildPreparedInvocationContext({
        instructionText: 'system',
        terminalToolNames: [],
        compiledTools: [],
        dynamicBlocks: [],
        preparedCompaction,
      }),
      capabilityRequest: {},
      routePass: { kind: 'ordinary', candidateChain: [candidate] },
      episodeContext: {},
    },
    summarizerProvider: {
      candidate,
      contextWindowTokens: 100000,
      maxOutputTokens: 10000,
      materializeImage: async () => { throw new Error('Unexpected image materialization.'); },
      serializeSummaryRequest: deterministicSummarySerialization,
      completeTurn: async () => ({
        result: { kind: 'message' as const, content: 'summary' },
        provider_exchanges: [],
      }),
      projectProviderExchanges: jest.fn(),
    },
    signal: new AbortController().signal,
    progress: noCompactionProgress,
  });
  expect(result.kind).toBe('compacted');
  return { before, after: readCurrentConversationSegment(root, SESSION)! };
}
it.each(['current', 'previous'] as const)(
  'spawned %s-index torn repair leaves refused bytes unchanged, then reports consented ordering and restarts',
  async (mode) => {
    let calls = 0;
    const provider = createServer((_req, res) => {
      calls++;
      res.statusCode = 500;
      res.end();
    });
    const port = await listen(provider);
    try {
      const f = fixture(port);
      const { before, after } = await compactFixture(f.root);
      const selected = mode === 'current' ? after : before;
      const path = cardConversationVersionFile(
        f.root,
        'project',
        'planner',
        selected.entry.filename,
      );
      const selectedBytes = readFileSync(path);
      appendFileSync(path, 'torn suffix');
      const index = cardConversationVersionIndexFile(f.root, 'project', 'planner');
      if (mode === 'previous') {
        unlinkSync(index);
        writeFileSync(index, 'broken index');
      }
      const bytes = snapshot([path, index]);
      const refused = await repair(f, `conversation:${SESSION}`, [], true);
      expect(refused.code).not.toBe(0);
      unchanged(bytes);
      const repaired = await repair(f, `conversation:${SESSION}`);
      expect(repaired.code).toBe(0);
      expect(readFileSync(path)).toEqual(selectedBytes);
      const report = readFileSync(repaired.report, 'utf8');
      expect(report).toContain('Truncate only');
      if (mode === 'previous')
        expect(report.indexOf('Completed: Fresh-publish')).toBeLessThan(
          report.indexOf('Completed: Truncate'),
        );
      else expect(readFileSync(index)).toEqual(bytes[1]!.bytes);
      await ready(f.root, () => calls);
      expect(calls).toBe(0);
    } finally {
      await closeServer(provider);
    }
  },
  60_000,
);
it('spawned indexed rollback preserves predecessor, refuses torn historical qualification, then restarts', async () => {
  let calls = 0;
  const provider = createServer((_req, res) => {
    calls++;
    res.statusCode = 500;
    res.end();
  });
  const port = await listen(provider);
  try {
    const f = fixture(port);
    const { before, after } = await compactFixture(f.root);
    const older = cardConversationVersionFile(f.root, 'project', 'planner', before.entry.filename);
    const newest = cardConversationVersionFile(f.root, 'project', 'planner', after.entry.filename);
    const beforeBytes = readFileSync(older);
    writeFileSync(newest, 'complete malformed\n');
    appendFileSync(older, 'historical torn');
    const index = cardConversationVersionIndexFile(f.root, 'project', 'planner');
    const damaged = snapshot([older, newest, index]);
    expect((await repair(f, `conversation:${SESSION}`)).code).not.toBe(0);
    unchanged(damaged);
    writeFileSync(older, beforeBytes);
    const result = await repair(f, `conversation:${SESSION}`);
    expect(result.code).toBe(0);
    expect(readCurrentConversationSegment(f.root, SESSION)!.entry.entry_id).toBe(
      before.entry.entry_id,
    );
    expect(readFileSync(older)).toEqual(beforeBytes);
    expect(readFileSync(result.report, 'utf8')).toContain('Unknown potentially days-long');
    expect(existsSync(newest)).toBe(false);
    await ready(f.root, () => calls);
  } finally {
    await closeServer(provider);
  }
}, 60_000);

it('spawned child discard preserves namespace/sibling/parent; restart launches no work, then active Planner rejects FAILED, metadata-reopens and activates placeholders', async () => {
  let calls = 0,
    analyst = 0,
    planner = 0,
    executor = 0;
  let fixtureError: Error | undefined;
  let childId = '';
  let cards: CardService;
  let placeholder: unknown;
  const provider = createServer(async (req, res) => {
    try {
      calls++;
      const body = await readJsonRequest(req);
      const tools = offeredToolNames(body);
      if (tools.includes('start_project')) {
        if (++analyst === 1) sendToolCall(res, 'run', 'start_project', {});
        else sendFinalMessage(res, 'Started');
      } else if (tools.includes('activate_card')) {
        planner++;
        if (planner === 1)
          sendToolCall(res, 'failed-direct', 'activate_card', { card_id: childId });
        else if (planner === 2) {
          expect(JSON.stringify(body.messages)).toContain('not activatable');
          expect(cards.read(childId)!.lifecycle.status).toBe('failed');
          sendToolCall(res, 'reopen', 'edit_card', {
            card_id: childId,
            title: 'Planner metadata reopening',
          });
        } else if (planner === 3) {
          expect(cards.read(childId)!.lifecycle.status).toBe('changed');
          expect(brief(cards, childId)).toEqual(placeholder);
          sendToolCall(res, 'activate-reopened', 'activate_card', { card_id: childId });
        } else
          sendToolCall(res, 'parent-blocked', 'emit_result', {
            outcome: 'blocked',
            summary: 'Verified placeholder activation',
          });
      } else {
        executor++;
        expect(cards.read(childId)!.lifecycle.status).toBe('running');
        expect(brief(cards, childId)).toEqual(placeholder);
        sendToolCall(res, 'child-done', 'emit_result', {
          outcome: 'done',
          summary: 'Placeholder activated',
        });
      }
    } catch (error) {
      fixtureError = error as Error;
      res.statusCode = 500;
      res.end();
    }
  });
  const port = await listen(provider);
  try {
    const f = fixture(port, (value) => {
      value.card_types.code.permitted_child_types = ['code'];
      for (const type of ['project', 'code'])
        for (const node of Object.values(value.card_types[type]!.workflow.nodes)) {
          node.records = {};
          for (const edge of Object.values(node.edges))
            if ('terminal' in edge.target) edge.target.export_records = [];
        }
    });
    cards = f.cards;
    const child = create(cards);
    childId = child.id;
    const descendant = create(cards, 'code', child.id);
    const sibling = create(cards);
    const preserved = snapshot([
      cardHeadFile(f.root, 'project'),
      cardHeadFile(f.root, descendant.id),
      cardHeadFile(f.root, sibling.id),
    ]);
    breakHeads(f.root, child.id);
    const result = await repair(f, `card:${child.id}`, ['--discard-card', '--card-type', 'code']);
    expect(result.code).toBe(0);
    unchanged(preserved);
    expect(cards.read(descendant.id)).toBeNull();
    placeholder = cards.readRecordCurrent(child.id, 'brief.md');
    expect(placeholder).toMatchObject({
      kind: 'found',
      value: {
        projection: {
          accepted: {
            writer_agent: 'runtime:repair',
            content: expect.stringContaining('placeholder requirements'),
          },
        },
      },
    });
    placeholder = brief(cards, childId);
    const app = await ready(f.root, () => calls);
    expect(calls).toBe(0);
    expect(cards.read(child.id)!.lifecycle.status).toBe('failed');
    // A stopped server has no active-parent invocation authority. Before Run,
    // the same production admission rule supplies no FAILED activation entry;
    // the real active-parent tool rejection is exercised immediately after Run.
    expect(cardProcessEntryForStatus(cards.read(child.id)!.lifecycle.status)).toBeNull();
    expect((await postStartProject(appOrigin(app), TOKEN)).status).toBe(200);
    await waitFor(() => fixtureError !== undefined || executor > 0, 'reopened child activation');
    if (fixtureError) throw fixtureError;
    expect(executor).toBeGreaterThan(0);
    expect(brief(cards, childId)).toEqual(placeholder);
  } finally {
    for (const app of apps) await app.stop();
    apps.clear();
    await closeServer(provider);
  }
}, 60_000);

it('spawned project discard preserves child bytes/globals/source/config/log; healthy-card record damage refuses; dangling dependencies fail restart unchanged', async () => {
  let calls = 0;
  const provider = createServer((_req, res) => {
    calls++;
    res.statusCode = 500;
    res.end();
  });
  const port = await listen(provider);
  try {
    const f = fixture(port);
    const child = create(f.cards);
    writeFileSync(join(f.root, 'source.md'), 'source');
    appendAppLogEntry(f.root, 'event', () => ({
      type: 'event',
      data: {
        kind: 'runtime_diagnostic',
        id: 'retained',
        timestamp: new Date().toISOString(),
        error_message: 'retained',
      },
    }));
    const kept = snapshot([
      cardHeadFile(f.root, child.id),
      globalAgentConversationVersionIndexFile(f.root, 'analyst'),
      join(f.root, '.saivage/saivage.yaml'),
      join(f.root, 'source.md'),
      appLogFile(f.root),
    ]);
    breakHeads(f.root, 'project');
    expect((await repair(f, 'card:project', ['--discard-card'])).code).toBe(0);
    unchanged(kept);
    await ready(f.root, () => calls);
    const g = fixture(port);
    const owner = create(g.cards);
    const definition = {
      filename: 'brief.md',
      format: 'markdown' as const,
      schema: 'card-brief.v1',
      bootstrap: true,
      declared: true,
    };
    writeFileSync(cardRecordHeadFile(g.root, owner.id, definition), 'broken record');
    const head = snapshot([cardHeadFile(g.root, owner.id)]);
    expect(
      (await repair(g, `card:${owner.id}`, ['--discard-card', '--card-type', 'code'])).code,
    ).not.toBe(0);
    unchanged(head);
    const h = fixture(port);
    const goal = create(h.cards, 'goal');
    const lost = create(h.cards, 'code', goal.id);
    const dependent = create(h.cards, 'code', 'project', [lost.id]);
    const dep = snapshot([cardHeadFile(h.root, dependent.id)]);
    breakHeads(h.root, goal.id);
    expect(
      (await repair(h, `card:${goal.id}`, ['--discard-card', '--card-type', 'goal'])).code,
    ).toBe(0);
    await expect(startProductionApp(h.root, TOKEN)).rejects.toThrow(/current linked card graph/);
    unchanged(dep);
    expect(calls).toBe(0);
  } finally {
    await closeServer(provider);
  }
}, 60_000);
