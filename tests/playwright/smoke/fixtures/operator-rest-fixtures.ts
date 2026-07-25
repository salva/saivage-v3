import type { Page, Route } from '@playwright/test';
import { parseOperatorResponse } from '../../../../src/contracts/operator-api.js';

const now = '2026-05-19T12:00:00.000Z';
export const smokeCardId = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const runtimeRunning = {
  status: 'running',
  project_id: 'project',
  pid: 4242,
  started_at: now,
  current_card_id: smokeCardId,
  updated_at: now,
};

export const smokeOperatorCard = {
  id: smokeCardId,
  type: 'code',
  title: 'Synthetic dashboard smoke card',
  lifecycle: { status: 'done', result: { kind: 'workflow-result', terminal: 'DONE', agent_name: 'executor', node_id: 'execute', outcome: 'done', summary: 'synthetic result', records: [{ name: 'status.md', url: `record:///status.md?card=${smokeCardId}&v=1`, version: 1 }] }, error: null, completed_at: now },
  urgency: 'normal',
  created_at: now,
  updated_at: now,
  allowedActions: [],
  version_seq: 3,
};
const card = smokeOperatorCard;
const rawCard = { id:smokeCardId,type:'code',children:[],title:card.title,lifecycle:card.lifecycle,subtype:null,tags:['smoke'],priority:90,urgency:'normal',created_by:'analyst',created_at:now,updated_at:now,version_seq:3,assigned_to:null,depends_on:[],related:[],metrics:null,estimate:null,started_at:null,duration_ms:null,status_text:'synthetic result',status_text_updated_at:now,status_text_author_session_id:null,latest_self_report:null,metadata:null,pending_notifications:[] };
const priorCard = {
  ...rawCard,
  lifecycle: { status: 'running' as const, result: null, error: null, completed_at: null },
  status_text: null,
  status_text_updated_at: null,
  version_seq: 2,
};
const terminalHistory = {
  entry_id: '11111111-1111-4111-8111-111111111111', kind: 'terminal' as const, card_id: smokeCardId, version_seq: 2,
  changed_at: now, changed_by_actor: 'runtime' as const, changed_by_surface: 'runtime' as const,
  change_reason: 'terminal lifecycle commit', changed_fields: ['lifecycle', 'status_text', 'status_text_updated_at'],
  change_summary: 'lifecycle, status_text, status_text_updated_at updated',
};
const historyList = parseOperatorResponse('cards.history.list', { history: [terminalHistory], total: 1 });
const historyEntry = parseOperatorResponse('cards.history.get', { entry: { ...terminalHistory, snapshot: priorCard } });
const historyDiff = parseOperatorResponse('cards.diff', { card_id: smokeCardId, from: 2, to: 3, diff: [{ field: 'lifecycle', before: priorCard.lifecycle, after: card.lifecycle }, { field: 'status_text', before: null, after: rawCard.status_text }, { field: 'status_text_updated_at', before: null, after: now }] });

const projectCard = {
  id: 'project',
  type: 'project',
  title: 'Synthetic Project',
  status: 'running',
};

const hierarchyCard={id:smokeCardId,type:'code',title:card.title,status:'done'} as const;
const rootChildren = parseOperatorResponse('cards.children', { parent: projectCard, children: [hierarchyCard] });
export const cardRecords = [
  { name: 'brief.md', format: 'markdown' as const, schema: 'card-brief.v1', writers: ['analyst', 'executor'], bootstrap: true },
  { name: 'status.md', format: 'markdown' as const, schema: 'work-status.v1', writers: ['executor'], bootstrap: false },
];
const cardDetail = parseOperatorResponse('cards.get', { card });
const recordList = parseOperatorResponse('cards.records.list', { card_id:smokeCardId,records:cardRecords });
const debugErrors = parseOperatorResponse('debug.errors', {
  errors: [{
    id: 'err-playwright-1',
    kind: 'runtime_diagnostic',
    error_message: 'Synthetic provider failure redacted',
    phase: 'planner-smoke',
    timestamp: now,
  }],
  total: 1,
});
const debugTimeline = parseOperatorResponse('events.list', {
  events: [
    { id: 'evt-1', kind: 'runtime_diagnostic', phase: 'planner-smoke', timestamp: now, error_message: 'Synthetic provider failure redacted' },
    { id: 'evt-2', kind: 'mcp_tool_invocation', server: 'filesystem', tool: 'read', success: true, duration_ms: 5, timestamp: now },
  ],
  total: 2,
});
const codeDebugGraph = {
    card_type: 'code', permitted_child_types: [],
    records: [{ name: 'brief.md', format: 'markdown', schema: 'card-brief.v1', writers: ['executor'], bootstrap: true }, { name: 'status.md', format: 'markdown', schema: 'work-status.v1', writers: ['executor'], bootstrap: false }],
    entries: ['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'].map((entry) => ({ entry, node_id: 'execute', prompt_reference: entry === 'STOPPED' ? 'stopped-recovery' : null })),
    nodes: [{ node_id: 'execute', agent_name: 'executor', session: { scope: 'card', identity_pattern: 'agent:executor:<card-id>' }, prompt: { source: 'bundled', reference: 'executor', process_reference: 'execute', correction_reference: 'correct-execute-result' }, model: { route: 'executor', candidates: [{ provider: 'synthetic', model: 'synthetic-model' }], temperature: 0.2, max_tokens: 4096 }, skills: true, tools: ['read', 'write', 'edit'], child_creation_types: [], child_activation_types: [], readable_records: ['brief.md', 'status.md'], writable_records: ['brief.md', 'status.md'], requirements: [{ record_name: 'status.md', kind: 'updated' }], descendant_context: null, outcomes: ['done'] }],
    edges: [{ source_node_id: 'execute', outcome: 'done', runtime_owned: false, prompt_reference: null, target: { kind: 'terminal', terminal: 'DONE' }, export_records: ['status.md'], promotion: { kind: 'current' } }, { source_node_id: 'execute', outcome: 'execution:failed', runtime_owned: true, prompt_reference: null, target: { kind: 'terminal', terminal: 'FAILED' }, export_records: [], promotion: null }],
    terminals: [{ terminal: 'DONE' }, { terminal: 'BLOCKED' }, { terminal: 'FAILED' }],
};
const debugGraphs = parseOperatorResponse('debug.graphs', {
  graphs: [codeDebugGraph, { ...codeDebugGraph, card_type: 'goal', permitted_child_types: ['code'] }],
});

const sessions = [
  { id: 'agent:analyst:global', agent_name: 'analyst', session_scope: 'global', card_id: null, started_at: now },
  { id: `agent:executor:${smokeCardId}`, agent_name: 'executor', session_scope: 'card', card_id: smokeCardId, started_at: now },
  { id: 'agent:planner:project', agent_name: 'planner', session_scope: 'card', card_id: 'project', started_at: now },
  { id: 'agent:reviewer:project', agent_name: 'reviewer', session_scope: 'card', card_id: 'project', started_at: now },
];

const metaRoot = {
  path: '.saivage',
  files: [
    { name: 'logs', path: '.saivage/logs', type: 'directory', modifiedAt: now },
    { name: 'plan.json', path: '.saivage/plan.json', type: 'file', size: 32, modifiedAt: now },
  ],
};
const metaLogs = {
  path: '.saivage/logs',
  files: [{ name: 'app.jsonl', path: '.saivage/logs/app.jsonl', type: 'file', size: 128, modifiedAt: now }],
};
const outputReports = {
  path: '.saivage/work/reports',
  files: [
    { name: 'summary.md', path: '.saivage/work/reports/summary.md', type: 'file', size: 72, modifiedAt: now },
  ],
};
const outputRoot = {
  path: '.saivage/work',
  files: [
    { name: 'reports', path: '.saivage/work/reports', type: 'directory', modifiedAt: now },
    { name: 'smoke-result.json', path: '.saivage/work/smoke-result.json', type: 'file', size: 64, modifiedAt: now },
    { name: 'LICENSE', path: '.saivage/work/LICENSE', type: 'file', size: 48, modifiedAt: now },
    { name: 'redacted-config.json', path: '.saivage/work/redacted-config.json', type: 'file', size: 96, modifiedAt: now },
    { name: 'blocked-secret.json', path: '.saivage/work/blocked-secret.json', type: 'file', size: 96, modifiedAt: now },
    { name: 'missing-log.txt', path: '.saivage/work/missing-log.txt', type: 'file', size: 16, modifiedAt: now },
    { name: 'binary.bin', path: '.saivage/work/binary.bin', type: 'file', size: 4096, modifiedAt: now },
    { name: 'huge.log', path: '.saivage/work/huge.log', type: 'file', size: 5242880, modifiedAt: now },
  ],
};
export const processOwnerId = '11111111-1111-4111-8111-111111111111:node:0';
export const processId = 'proc-111111111111';
export const expectedProcessList = { processes: [{ id: processId, status: 'exited', command: 'npm run synthetic-smoke', cwd: '.', card_id: smokeCardId, session_id: processOwnerId, owner_id: processOwnerId, owner_kind: 'agent' as const, started_at: now, ended_at: now, exit_code: 0, timed_out: false, logs: { stdout: `work:///cards/${smokeCardId}/processes/${processId}/stdout.log`, stderr: `work:///cards/${smokeCardId}/processes/${processId}/stderr.log` } }] };
export const processListResponse = parseOperatorResponse('processes.list', expectedProcessList);

function stampedText(sessionId: string, id: string, content: string) {
  return { id, session_id: sessionId, role: 'assistant', kind: 'text', content, round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: now };
}

export type OperatorRestOptions = {
  unauthorized?: boolean | ((method: string, pathname: string) => boolean);
};

export type OperatorRestObservations = {
  counts: Map<string, number>;
  unknown: string[];
  chatPosts: Array<{ sessionId: string; body: Record<string, unknown> }>;
  authorizations: string[];
};

function json(route: Route, payload: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

function keyFor(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`;
}

export async function installOperatorRestRoutes(page: Page, options: OperatorRestOptions = {}): Promise<OperatorRestObservations> {
  const observations: OperatorRestObservations = { counts: new Map(), unknown: [], chatPosts: [], authorizations: [] };

  const chatEntries = new Map<string, ReturnType<typeof stampedText>[]>();

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = keyFor(request.method(), url.pathname);
    observations.counts.set(key, (observations.counts.get(key) ?? 0) + 1);
    const authorization = request.headers().authorization;
    if (authorization) observations.authorizations.push(authorization);
    const shouldReject = typeof options.unauthorized === 'function'
      ? options.unauthorized(request.method(), url.pathname)
      : options.unauthorized === true;
    if (shouldReject) {
      return json(route, { error: 'unauthorized', message: 'Synthetic 401: valid API token required' }, 401);
    }

    if (request.method() === 'POST' && url.pathname === '/api/auth/ws-ticket') {
      return json(route, { ticket: 'synthetic-ws-ticket', expiresAt: '2026-05-19T12:05:00.000Z' });
    }
    if (request.method() === 'GET' && url.pathname === '/api/state') {
      return json(route, parseOperatorResponse('runtime.getState', { projectRoot: '/work/saivage-e2e-checkers', projectId: 'project', runtime: runtimeRunning }));
    }
    if (request.method() === 'GET' && url.pathname === '/api/runtime/status') {
      return json(route, parseOperatorResponse('runtime.status', { runtime: 'running', currentCardId: smokeCardId, started_at: now, pid: 4242, actorRuntime: { pauseMode: 'running', cards: [{ cardId: smokeCardId, actorState: 'running', processState: { cardType: 'code', stateId: 'node:execute', kind: 'node', nodeId: 'execute', executionOrdinal: 0 } }] }, restart_server_available: false }));
    }
    if (request.method() === 'GET' && url.pathname === '/api/cards/project/children') return json(route, rootChildren);
    if (request.method() === 'GET' && url.pathname === `/api/cards/${smokeCardId}/children`) return json(route, parseOperatorResponse('cards.children', { parent: hierarchyCard, children: [] }));
    if (request.method() === 'GET' && url.pathname === `/api/cards/${smokeCardId}`) return json(route, cardDetail);
    if (request.method() === 'GET' && url.pathname === `/api/cards/${smokeCardId}/records`) return json(route, recordList);
    if (request.method() === 'GET' && url.pathname.startsWith(`/api/cards/${smokeCardId}/records/`)) {
      const name=decodeURIComponent(url.pathname.split('/').at(-1) ?? 'brief.md');
      return json(route, parseOperatorResponse('cards.records.get',{card_id:smokeCardId,record:{name,version:1,committed_at:now,content:`Synthetic ${name} content`}}));
    }
    if (request.method() === 'GET' && url.pathname === `/api/cards/${smokeCardId}/history`) return json(route, historyList);
    if (request.method() === 'GET' && url.pathname === `/api/cards/${smokeCardId}/history/2`) return json(route, historyEntry);
    if (request.method() === 'GET' && url.pathname === `/api/cards/${smokeCardId}/diff`) return json(route, historyDiff);
    if (request.method() === 'GET' && url.pathname === '/api/agents') return json(route, parseOperatorResponse('agents.list', { sessions }));
    if (request.method() === 'GET' && url.pathname === `/api/cards/${smokeCardId}/agent-sessions`) {
      return json(route, parseOperatorResponse('agents.cardSessions', {
        card_id: smokeCardId,
        sessions: sessions.filter((session) => session.card_id === smokeCardId),
      }));
    }
    if (request.method() === 'GET' && url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/conversation')) {
      const sessionId = decodeURIComponent(url.pathname.split('/')[3] ?? 'agent:analyst:global');
      const allEntries = sessionId === 'agent:analyst:global'
        ? chatEntries.get(sessionId) ?? [stampedText(sessionId, `chat-${sessionId}-1`, 'Synthetic agent transcript.')]
        : [stampedText(sessionId, `msg-${sessionId}-1`, 'Synthetic agent transcript.')];
      const since = url.searchParams.get('since');
      const cursorIndex = since === null ? -1 : allEntries.findIndex((entry) => entry.id === since);
      const entries = cursorIndex < 0 ? allEntries : allEntries.slice(cursorIndex + 1);
      return json(route, parseOperatorResponse('agents.conversation', {
        session_id: sessionId,
        entries,
        cursor: allEntries.at(-1)?.id ?? since,
      }));
    }
    if (request.method() === 'GET' && url.pathname.startsWith('/api/agents/') && url.pathname.split('/').length === 4) {
      const sessionId = decodeURIComponent(url.pathname.split('/')[3] ?? 'agent:analyst:global');
      return json(route, parseOperatorResponse('agents.detail', {
        session: sessions.find((session) => session.id === sessionId) ?? sessions[0],
      }));
    }
    if (request.method() === 'GET' && url.pathname === '/api/files') {
      const path = url.searchParams.get('path');
      if (path === '.saivage/logs') return json(route, metaLogs);
      if (path === '.saivage/work/reports') return json(route, outputReports);
      if (path === '.saivage/work' || !path) return json(route, path === '.saivage/work' ? outputRoot : metaRoot);
      if (path === '.saivage/plan.json' || path === '.saivage/logs/app.jsonl' || path === '.saivage/work/smoke-result.json' || path === '.saivage/work/LICENSE' || path === '.saivage/work/reports/summary.md') {
        return json(route, { error: 'Path is not a directory', path }, 400);
      }
      if (path === '.saivage/work/stale' || path === '.saivage/work/stale/missing-log.txt') {
        return json(route, { error: 'Path not found', path }, 404);
      }
      return json(route, metaRoot);
    }
    if (request.method() === 'GET' && url.pathname === '/api/files/content') {
      const path = url.searchParams.get('path') ?? '.saivage/plan.json';
      if (path === '.saivage/work/blocked-secret.json') {
        return json(route, { error: 'forbidden', message: 'Synthetic preview blocked by content safety policy' }, 403);
      }
      if (path === '.saivage/work/missing-log.txt' || path === '.saivage/work/stale/missing-log.txt') {
        return json(route, { error: 'not_found', message: 'Synthetic file no longer exists' }, 404);
      }
      if (path === '.saivage/work/binary.bin') {
        return json(route, { error: 'unsupported_media_type', message: 'Synthetic binary preview unavailable' }, 415);
      }
      if (path === '.saivage/work/huge.log') {
        return json(route, { error: 'payload_too_large', message: 'Synthetic file is too large for inline preview' }, 413);
      }
      if (path === '.saivage/work/redacted-config.json') {
        return json(route, {
          path,
          size: 96,
          contentType: 'application/json',
          content: JSON.stringify({ provider: 'synthetic', token: '[REDACTED]' }),
          redacted: true,
          sensitivity: 'sensitive-redacted',
        });
      }
      if (path === '.saivage/work/reports/summary.md') {
        return json(route, {
          path,
          size: 72,
          contentType: 'text/markdown',
          content: '# Synthetic report\n\nDirectory deep-link content.',
          redacted: false,
          sensitivity: 'normal',
        });
      }
      if (path === '.saivage/work/LICENSE') {
        return json(route, {
          path,
          size: 48,
          contentType: 'text/plain',
          content: 'synthetic extensionless output preview',
          redacted: false,
          sensitivity: 'normal',
        });
      }
      if (path === '.saivage/work/smoke-result.json') {
        return json(route, {
          path,
          size: 64,
          contentType: 'application/json',
          content: JSON.stringify({ result: 'synthetic output preview', ok: true }),
          redacted: false,
          sensitivity: 'normal',
        });
      }
      return json(route, {
        path,
        size: 32,
        contentType: 'application/json',
        content: JSON.stringify({ project: 'synthetic-project', stage: 'operator-playwright-smoke' }),
        redacted: false,
        sensitivity: 'normal',
      });
    }
    if (request.method() === 'GET' && url.pathname === '/api/debug/errors') {
      return json(route, debugErrors);
    }
    if (request.method() === 'GET' && url.pathname === '/api/debug/graphs') return json(route, debugGraphs);
    if (request.method() === 'GET' && url.pathname === '/api/events') {
      return json(route, debugTimeline);
    }
    if (request.method() === 'GET' && url.pathname === '/api/debug/doctor') return json(route, { status: 'ok', checks: [], issues: [] });
    if (request.method() === 'GET' && url.pathname === '/api/mcp/tools') {
      return json(route, parseOperatorResponse('mcp.tools', {
        servers: [{ name: 'filesystem', status: 'running', transport: 'stdio', toolCount: 1, tools: [{ name: 'read', stats: { total: 3, success: 2, error: 1, lastInvokedAt: now } }] }],
      }));
    }
    if (request.method() === 'GET' && url.pathname === '/api/processes') {
      return json(route, processListResponse);
    }
    if (request.method() === 'GET' && url.pathname === '/api/notifications') return json(route, { notifications: [], total: 0 });
    if (request.method() === 'GET' && url.pathname === '/api/control-actions') return json(route, { control_actions: [], total: 0 });
    if (request.method() === 'GET' && url.pathname === '/api/chat') {
      const sessionId = 'agent:analyst:global';
      return json(route, parseOperatorResponse('chats.get', { session_id: sessionId }));
    }
    if (request.method() === 'POST' && url.pathname === '/api/chat') {
      const sessionId = 'agent:analyst:global';
      let body: Record<string, unknown> = {};
      try {
        body = request.postDataJSON() as Record<string, unknown>;
      } catch {
        body = {};
      }
      observations.chatPosts.push({ sessionId, body });
      const content = typeof body.content === 'string' ? body.content : '';
      const visiblePrompt = content.split('\n\n').at(-1)?.trim() || content.trim();
      const message = {
        id: `chat-${sessionId}-assistant`,
        session_id: sessionId,
        role: 'assistant' as const,
        kind: 'text' as const,
        content: `Synthetic analyst response to: ${visiblePrompt}`,
        round_id: 'r-assistant-00000000000000000000000000000002',
        message_index: 1,
        block_index: 0,
        timestamp: now,
      };
      chatEntries.set(sessionId, [stampedText(sessionId, `chat-${sessionId}-1`, 'Synthetic agent transcript.'), message]);
      return json(route, parseOperatorResponse('chats.send', {
        sessionId,
        toolInvocations: [],
        restart: null,
      }));
    }

    observations.unknown.push(key);
    return json(route, { error: 'unknown_playwright_fixture_route', message: `No deterministic Playwright fixture for ${key}` }, 599);
  });

  return observations;
}
