import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from '@jest/globals';

import { AgentOperatorReadModelService } from '../../src/application/read-models/agent-operator-read-model.js';
import { appLogEntrySchema, type AppLogEntry } from '../../src/contracts/app-log.js';
import { serializeToolCallMessage } from '../../src/contracts/persisted-tool-call.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { serializeGrowingEnvelope } from '../../src/persistence/growing-file.js';
import { appLogFile, cardStreamFile } from '../../src/persistence/layout.js';
import { cardStreamRowSchema } from '../../src/persistence/canonical-card-artifacts.js';
import { publishInitialChildCard, readCardArtifacts } from '../../src/persistence/card-files.js';
import { conversationFile } from '../../src/runtime/actors/conversation-inventory.js';
import {
  agentMessageSchema,
  cardAgentSessionId,
  globalAgentSessionId,
  type AgentMessage,
  type CardRecord,
  type ConversationSessionId,
} from '../../src/schemas/index.js';
import { compactedConversationFixture } from '../helpers/compacted-conversation-fixture.js';
import { initProjectTree, CardService, TEST_WORKFLOWS } from '../helpers/canonical-project.js';

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
type PerformanceResult = {
  globalRuns: Measurement[];
  cardScope: Measurement;
  cardScopeLedgers: Record<string, { openAttempts: number; bytesRead: number; closes: number }>;
};

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const stamp = '2026-07-24T00:00:00.000Z';
const GLOBAL_RUNS = 7;
const APP_LOG_ROWS = 8_800;

describe('pueblicos-shaped Agent summary cost', () => {
  it('measures first-envelope-only global and one-card reads independently of long history and app log', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-summary-performance-'));
    roots.push(root);
    const fixture = createPueblicosFixture(root);

    // Prove the deliberately rich later history itself is canonical before measuring summary reads.
    const validTranscript = new AgentOperatorReadModelService(root, TEST_WORKFLOWS).getConversation(
      fixture.longHistorySession,
    );
    expect(validTranscript.entries.length).toBeGreaterThan(200);
    expect(() =>
      new AgentOperatorReadModelService(root, TEST_WORKFLOWS).getConversation(fixture.poisonedSession),
    ).toThrow(/malformed/);

    const { globalRuns, cardScope, cardScopeLedgers } = runMeasurements(root, fixture);
    const elapsed = globalRuns.map((run) => run.elapsedMs).sort((a, b) => a - b);
    const medianMs = percentile(elapsed, 0.5);
    const p95Ms = percentile(elapsed, 0.95);
    expect(medianMs).toBeLessThanOrEqual(6_000);
    for (const run of globalRuns) {
      expect(run.candidateOpens).toBe(fixture.candidatePaths.size);
      expect(run.candidateCloses).toBe(fixture.candidatePaths.size);
      expect(run.candidatePathsReadOnce).toBe(true);
      expect(run.candidateBytes).toBe(fixture.firstEnvelopeBytes);
      expect(run.appLogOpens).toBe(0);
      expect(run.snapshotOpens).toBe(0);
    }

    expect(cardScope.candidateOpens).toBe(fixture.measuredCardCandidatePaths.size);
    expect(cardScope.candidateCloses).toBe(fixture.measuredCardCandidatePaths.size);
    expect(cardScope.candidatePathsReadOnce).toBe(true);
    expect(cardScope.candidateBytes).toBe(fixture.measuredCardFirstEnvelopeBytes);
    expect(cardScope.appLogOpens).toBe(0);
    expect(cardScope.snapshotOpens).toBe(0);
    for (const [path, ledger] of Object.entries(cardScopeLedgers)) {
      if (!fixture.measuredCardCandidatePaths.has(path)) expect(ledger.openAttempts).toBe(0);
      else expect(ledger).toMatchObject({ openAttempts: 1, closes: 1 });
    }

    const report = {
        fixture: {
          linkedCards: fixture.linkedCards,
          candidateConversations: fixture.candidatePaths.size,
          appLogRows: APP_LOG_ROWS,
          appLogBytes: readFileSync(fixture.appPath).byteLength,
          longHistoryRows: fixture.longHistoryRows,
        },
        global: {
          runs: GLOBAL_RUNS,
          elapsedMs: globalRuns.map((run) => round(run.elapsedMs)),
          cpuMsPerRun: globalRuns.map((run) => round(run.cpuMs)),
          medianMs: round(medianMs),
          p95Ms: round(p95Ms),
          cpuMs: round(globalRuns.reduce((total, run) => total + run.cpuMs, 0)),
          exactCandidateOpensPerRun: fixture.candidatePaths.size,
          firstEnvelopeBytesPerRun: fixture.firstEnvelopeBytes,
          laterEnvelopeBytesPerRun: 0,
          appLogPassesPerRun: 0,
          snapshotReadsPerRun: 0,
          completeFoldReadsPerRun: 0,
        },
        cardScope: {
          cardId: fixture.measuredCardId,
          elapsedMs: round(cardScope.elapsedMs),
          cpuMs: round(cardScope.cpuMs),
          exactCandidateOpens: cardScope.candidateOpens,
          firstEnvelopeBytes: cardScope.candidateBytes,
          laterEnvelopeBytes: 0,
          unrelatedCandidateOpens: 0,
          appLogPasses: 0,
          snapshotReads: 0,
          completeFoldReads: 0,
        },
    };
    process.stdout.write(`AGENT_SUMMARY_PERFORMANCE ${JSON.stringify(report)}\n`);
  }, 60_000);
});

function runMeasurements(root: string, fixture: ReturnType<typeof createPueblicosFixture>): PerformanceResult {
  const inputPath = join(root, 'agent-summary-performance-input.json');
  writeFileSync(inputPath, JSON.stringify({
    root,
    candidatePaths: [...fixture.candidatePaths],
    appPath: fixture.appPath,
    measuredCardId: fixture.measuredCardId,
    runs: GLOBAL_RUNS,
  }));
  const child = fileURLToPath(new URL('../fixtures/agent-summary-performance-child.ts', import.meta.url));
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', child, inputPath], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }).trim()) as PerformanceResult;
}

function createPueblicosFixture(root: string) {
  initProjectTree(root);
  const cards = new CardService(root);
  const project = cards.read('project')!;
  const workflow = TEST_WORKFLOWS.cardTypes.get('code')!;
  const children: CardRecord[] = [];
  for (let index = 0; index < 115; index++)
    children.push(
      publishInitialChildCard(
        root,
        {
          type: 'code', parent: 'project', title: `card ${index}`, bootstrap_content: 'brief',
          tags: [], priority: index, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
        },
        workflow,
      ),
    );
  const artifacts = [readCardArtifacts(root, 'project').artifacts[0]!];
  let linked = project;
  for (const child of children) {
    const prior = linked;
    const committed_at = new Date(new Date(prior.updated_at).getTime() + 1).toISOString();
    linked = { ...prior, children: [...prior.children, child.id], version_seq: prior.version_seq + 1, updated_at: committed_at };
    artifacts.push({
      kind: 'card-version' as const, format_version: 2 as const, card_id: 'project' as const,
      version: linked.version_seq, committed_at, card: linked,
      history: {
        entry_id: randomUUID(), kind: 'child_link' as const, card_id: 'project' as const,
        version_seq: prior.version_seq, snapshot: prior, changed_at: committed_at,
        changed_by_actor: 'runtime' as const, changed_by_surface: 'runtime' as const,
        change_reason: 'child linked', changed_fields: ['children'], change_summary: `linked child ${child.id}`,
      },
    });
  }
  writeFileSync(cardStreamFile(root, 'project'), serializeGrowingEnvelope(artifacts, cardStreamRowSchema));

  const allCards = [linked, ...children];
  const sessions: ConversationSessionId[] = [globalAgentSessionId(TEST_WORKFLOWS.analyst.name)];
  for (const card of allCards)
    for (const name of new Set([...TEST_WORKFLOWS.cardTypes.get(card.type)!.nodes.values()].map((node) => node.agent.name)))
      sessions.push(cardAgentSessionId(name, card.id));

  const longHistorySession = sessions.find((id) => id.includes(children[0]!.id))!;
  const poisonedSession = sessions.find((id) => id.includes(children[1]!.id))!;
  const longRows = richLaterHistory(longHistorySession);
  const poisonedRows = richLaterHistory(poisonedSession);
  for (const sessionId of sessions) {
    if (sessionId === longHistorySession || sessionId === poisonedSession) {
      const rows = sessionId === longHistorySession ? longRows : poisonedRows;
      appendConversationBatch({ projectRoot: root }, [rows[0]!]);
      appendConversationBatch({ projectRoot: root }, rows.slice(1));
    } else appendConversationBatch({ projectRoot: root }, [marker(sessionId, `${sessionId}-open`)]);
  }
  appendFileSync(conversationFile(root, poisonedSession), '{malformed complete envelope}\n');

  const appPath = appLogFile(root);
  mkdirSync(join(root, '.saivage', 'logs'));
  writeFileSync(appPath, serializeGrowingEnvelope(mixedAppLogRows(APP_LOG_ROWS), appLogEntrySchema));
  const candidatePaths = new Set(sessions.map((id) => conversationFile(root, id)));
  const measuredCardId = children[2]!.id;
  const measuredCardCandidatePaths = new Set(
    sessions.filter((id) => id.endsWith(`:${measuredCardId}`)).map((id) => conversationFile(root, id)),
  );
  return {
    linkedCards: allCards.length,
    candidatePaths,
    firstEnvelopeBytes: sumFirstEnvelopeBytes(candidatePaths),
    appPath,
    longHistorySession,
    poisonedSession,
    longHistoryRows: longRows.length,
    measuredCardId,
    measuredCardCandidatePaths,
    measuredCardFirstEnvelopeBytes: sumFirstEnvelopeBytes(measuredCardCandidatePaths),
  };
}

function richLaterHistory(sessionId: ConversationSessionId): AgentMessage[] {
  const compacted = compactedConversationFixture(sessionId, true).rows;
  const textRows = Array.from({ length: 220 }, (_, index) =>
    agentMessageSchema.parse({
      id: `later-${index}`, session_id: sessionId, role: 'assistant', kind: 'text',
      content: `later payload ${index} ${'x'.repeat(256)}`,
      round_id: `r-assistant-${String(index + 10).padStart(32, '0')}`,
      message_index: index, block_index: 0, timestamp: stamp,
    }),
  );
  const sourceInputId = '22222222-2222-4222-8222-222222222222';
  const callId = 'legacy-read';
  const toolRows = [
    agentMessageSchema.parse({
      id: `${sourceInputId}:tool-call:${callId}`, session_id: sessionId, role: 'assistant', kind: 'tool_call',
      content: JSON.stringify(serializeToolCallMessage({ id: callId, name: 'read_agent_session', args: {} })),
      tool: 'read_agent_session', tool_call_id: callId,
      round_id: `r-assistant-${'8'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: stamp,
    }),
    agentMessageSchema.parse({
      id: `${sourceInputId}:tool-result:${callId}`, session_id: sessionId, role: 'tool', kind: 'tool_result',
      content: JSON.stringify({ success: true, data: { session: { id: 'legacy' }, total_messages: 9, returned: 1, parse_errors: 0, messages: [{ arbitrary: { opaque: true } }] } }),
      tool: 'read_agent_session', tool_call_id: callId,
      round_id: `r-assistant-${'8'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: stamp,
    }),
  ];
  return [...compacted, ...textRows, ...toolRows];
}

function mixedAppLogRows(count: number): AppLogEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const timestamp = new Date(Date.UTC(2026, 6, 24, 0, 0, 0, index)).toISOString();
    if (index % 3 === 0)
      return appLogEntrySchema.parse({ type: 'event', data: { id: `event-${index}`, timestamp, kind: 'runtime_diagnostic', error_message: `diagnostic ${index}` } });
    if (index % 3 === 1)
      return appLogEntrySchema.parse({ type: 'control_action', data: { id: `control-${index}`, actor: 'runtime', surface: 'runtime', action: 'performance_fixture', target_kind: 'runtime', target_id: null, params_summary: '{}', outcome: 'ok', outcome_summary: 'fixture', created_at: timestamp } });
    const sourceInputId = `input-${index}`;
    return appLogEntrySchema.parse({
      type: 'provider_exchange',
      data: {
        session_id: `summary:${index}`, source_input_id: sourceInputId, attempt_index: 0, timestamp,
        payload: { contract_id: 'fixture.v1', contract_name: 'fixture', transport: 'generic', provider: 'test', model: 'fixture', source_input_id: sourceInputId, attempt_index: 0, request_params: {}, started_at: timestamp, completed_at: timestamp, status: 'ok', terminal_tool_fired: null, assistant_output_ids: [] },
      },
    });
  });
}

function marker(sessionId: ConversationSessionId, id: string): AgentMessage {
  const identity = sessionId.split(':');
  const cardId = identity[2] === 'global' ? null : identity.slice(2).join(':');
  return agentMessageSchema.parse({
    id, session_id: sessionId, role: 'system', kind: 'activity',
    content: JSON.stringify({ agent_name: identity[1], event: 'activation_open', input_id: '00000000-0000-4000-8000-000000000001', timestamp: stamp, ...(cardId ? { card_id: cardId } : {}) }),
    round_id: `r-user-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: stamp,
  });
}

function sumFirstEnvelopeBytes(paths: ReadonlySet<string>): number {
  let total = 0;
  for (const path of paths) {
    const bytes = readFileSync(path);
    total += bytes.indexOf(0x0a) + 1;
  }
  return total;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

function round(value: number): number { return Math.round(value * 100) / 100; }
