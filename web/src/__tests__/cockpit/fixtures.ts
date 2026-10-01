import type {
  AgentSession,
  CardDetail,
  CardHierarchyParent,
  CardHierarchyRecord,
  RuntimeStatusResponse,
  ServerAvailability,
} from '../../api/types';
import type { ConversationSessionId, OperatorApiSuccess } from '../../api/contracts';

export const fixtureTimestamp = '2026-09-24T12:00:00.000Z';

export function serverAvailability(overrides: Partial<ServerAvailability> = {}): ServerAvailability {
  return {
    generatedAt: fixtureTimestamp,
    components: {
      api: { state: 'available', source: 'health-check', checkedAt: fixtureTimestamp },
      runtime: { state: 'available', source: 'runtime-application', checkedAt: fixtureTimestamp },
      mcp: { state: 'idle', source: 'mcp-manager', checkedAt: fixtureTimestamp },
    },
    ...overrides,
  };
}

export function oversightSnapshot(overrides: Partial<RuntimeStatusResponse['oversight']> = {}): RuntimeStatusResponse['oversight'] {
  return {
    agent_name: 'oversight',
    session_id: 'agent:oversight:global',
    enabled: true,
    eligible: true,
    eligibility_reason: null,
    state: 'waiting',
    next_nominal_due: '2026-09-24T14:00:00.000Z',
    last_attempt: null,
    last_successful_at: null,
    service_epoch: fixtureTimestamp,
    ...overrides,
  };
}

export function runtimeStatusSnapshot(overrides: Partial<RuntimeStatusResponse> = {}): RuntimeStatusResponse {
  return {
    runtime: 'running',
    currentCardId: 'card-a-b',
    started_at: fixtureTimestamp,
    restart_server_available: false,
    pid: 4242,
    actorRuntime: {
      pauseMode: 'running',
      cards: [
        {
          cardId: 'card-a',
          actorState: 'running',
          processState: { cardType: 'goal', stateId: 'await', kind: 'node', nodeId: 'await', executionOrdinal: 3 },
        },
        {
          cardId: 'card-a-b',
          actorState: 'running',
          processState: { cardType: 'code', stateId: 'execute', kind: 'node', nodeId: 'execute', executionOrdinal: 12 },
        },
      ],
    },
    oversight: oversightSnapshot(),
    serverAvailability: serverAvailability(),
    ...overrides,
  };
}

export function noCurrentRuntimeStatus(overrides: Partial<RuntimeStatusResponse> = {}): RuntimeStatusResponse {
  return runtimeStatusSnapshot({
    runtime: 'stopped',
    currentCardId: null,
    actorRuntime: { pauseMode: 'idle', cards: [] },
    oversight: oversightSnapshot({ enabled: true, eligible: false, eligibility_reason: 'stopped', state: 'unavailable', next_nominal_due: null }),
    ...overrides,
  });
}

export function hierarchyRecord(id: string, overrides: Partial<CardHierarchyRecord> = {}): CardHierarchyRecord {
  const type = id === 'project' ? 'project' : id === 'card-a' ? 'goal' : 'code';
  return {
    id,
    type,
    title: id,
    status: 'backlog',
    permitted_child_types: type === 'code' ? [] : ['code'],
    ...overrides,
  } as CardHierarchyRecord;
}

export function hierarchyParent(id: string, overrides: Partial<CardHierarchyParent> = {}): CardHierarchyParent {
  const type = id === 'project' ? 'project' : id === 'card-a' ? 'goal' : 'code';
  return {
    id,
    type,
    title: id,
    status: 'running',
    permitted_child_types: type === 'code' ? [] : ['code'],
    ...overrides,
  };
}

export function cardDetail(id: string, overrides: Partial<CardDetail> = {}): CardDetail {
  const type = id === 'project' ? 'project' : id === 'card-a' ? 'goal' : 'code';
  return {
    id,
    type,
    title: id,
    lifecycle: { status: 'running', result: null, error: null, completed_at: null },
    version_seq: 3,
    urgency: 'normal',
    created_at: fixtureTimestamp,
    updated_at: fixtureTimestamp,
    allowedActions: [],
    ...overrides,
  } as CardDetail;
}

export function agentSession(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  const parsed = id.split(':');
  const agentName = parsed[1] ?? 'executor';
  const cardId = parsed.length > 2 && parsed[2] !== 'global' ? parsed[2] : null;
  return {
    id: id as ConversationSessionId,
    agent_name: agentName,
    session_scope: cardId ? 'card' : 'global',
    card_id: cardId,
    started_at: fixtureTimestamp,
    status: 'inactive',
    activity: 'idle',
    compaction: null,
    ...overrides,
  };
}

export function cyclicCodePresentation(): OperatorApiSuccess<'workflows.presentation'> {
  const graph = cyclicCodeGraph();
  return {
    card_type: graph.card_type,
    nodes: graph.nodes.map(({ node_id, agent_name }) => ({ node_id, agent_name })),
    entries: graph.entries.map(({ entry, node_id }) => ({ entry, node_id })),
    edges: graph.edges.map(({ source_node_id, outcome, condition, target }) => ({ source_node_id, outcome, condition, target })),
    terminals: graph.terminals,
    records: graph.records.map(({ name, bootstrap }) => ({ name, bootstrap })),
  };
}

export function cyclicCodeGraph(): OperatorApiSuccess<'debug.graphs'>['graphs'][number] {
  const prompt = { reference: 'prompts/code/execute.md', compactable: true };
  return {
    card_type: 'code',
    notification_recipient: 'planner',
    permitted_child_types: [],
    records: [
      { name: 'brief.md', format: 'markdown', schema: 'brief.v1', bootstrap: true },
      { name: 'notes.md', format: 'markdown', schema: 'notes.v1', bootstrap: false },
    ],
    entries: [
      { entry: 'BACKLOG', node_id: 'execute', prompt },
      { entry: 'CHANGED', node_id: 'execute', prompt },
      { entry: 'BLOCKED', node_id: 'execute', prompt },
      { entry: 'STOPPED', node_id: 'execute', prompt },
    ],
    nodes: [
      {
        node_id: 'execute',
        agent_name: 'executor',
        session: { scope: 'card', identity_pattern: 'agent:executor:{cardId}' },
        prompt: { source: 'bundled-card', declaration: prompt, process: prompt, correction: prompt },
        model: { route: 'sol', candidates: [{ provider: 'openai', model: 'sol' }], temperature: 0.2, max_tokens: 8192 },
        skills: false,
        tools: ['read_file'],
        child_creation_types: [],
        child_activation_types: [],
        readable_records: ['brief.md'],
        record_write_patterns: ['notes.md'],
        requirements: [{ record_name: 'brief.md', mode: 'clean', gate: 'exists' }],
        descendant_context: null,
        outcomes: ['done', 'needs-repair'],
      },
      {
        node_id: 'repair',
        agent_name: 'executor',
        session: { scope: 'card', identity_pattern: 'agent:executor:{cardId}' },
        prompt: { source: 'bundled-card', declaration: prompt, process: prompt, correction: prompt },
        model: { route: 'sol', candidates: [{ provider: 'openai', model: 'sol' }], temperature: 0.2, max_tokens: 8192 },
        skills: false,
        tools: ['read_file'],
        child_creation_types: [],
        child_activation_types: [],
        readable_records: ['brief.md'],
        record_write_patterns: ['notes.md'],
        requirements: [{ record_name: 'brief.md', mode: 'continue', gate: 'updated' }],
        descendant_context: null,
        outcomes: ['done', 'needs-repair'],
      },
    ],
    edges: [
      {
        source_node_id: 'execute',
        outcome: 'done',
        runtime_owned: false,
        condition: 'default',
        prompt,
        target: { kind: 'terminal', terminal: 'DONE' },
        export_records: ['notes.md'],
        promotion: null,
      },
      {
        source_node_id: 'execute',
        outcome: 'needs-repair',
        runtime_owned: false,
        condition: 'default',
        prompt,
        target: { kind: 'node', node_id: 'repair' },
        export_records: [],
        promotion: null,
      },
      {
        source_node_id: 'repair',
        outcome: 'needs-repair',
        runtime_owned: false,
        condition: 'default',
        prompt,
        target: { kind: 'node', node_id: 'execute' },
        export_records: [],
        promotion: null,
      },
      {
        source_node_id: 'repair',
        outcome: 'done',
        runtime_owned: false,
        condition: 'default',
        prompt,
        target: { kind: 'terminal', terminal: 'DONE' },
        export_records: ['notes.md'],
        promotion: null,
      },
    ],
    terminals: [{ terminal: 'DONE' }, { terminal: 'BLOCKED' }, { terminal: 'FAILED' }],
  };
}
