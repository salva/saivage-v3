import type { Page, Route } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';

const now = '2026-05-19T12:00:00.000Z';

const runtimeRunning = {
  status: 'running',
  project_id: 'project',
  pid: 4242,
  started_at: now,
  current_card_id: 'card-smoke',
  current_agent_session_id: 'planner-smoke',
  paused: false,
  paused_at: null,
  updated_at: now,
  runtime_intent: { status: 'running', updated_at: now, source_command_id: null, reason: null },
  runtime_commands: [],
  runtime_runs: [],
  runtime_activations: [],
};

const card = {
  id: 'card-smoke',
  type: 'code',
  parent: 'project-smoke',
  depth: 1,
  position: 1,
  title: 'Synthetic dashboard smoke card',
  description: 'Exercise operator dashboard surfaces without provider calls.',
  status: 'done',
  tags: ['smoke'],
  priority: 90,
  urgency: 'normal',
  created_by: 'user',
  created_at: now,
  updated_at: now,
  depends_on: [],
  blocks: [],
  related: [],
  acceptance: 'Synthetic acceptance only.',
  artifacts: [],
  attachments: [],
  retries: 0,
  result: { summary: 'synthetic result', checks: ['docs:verify', 'typecheck'] },
  version_seq: 3,
};

const projectCard = {
  ...card,
  id: 'project-smoke',
  type: 'project',
  parent: null,
  depth: 0,
  position: 0,
  title: 'Synthetic Project',
  priority: 50,
  status: 'running',
  result: null,
  version_seq: 1,
};

const cardList = parseOperatorResponse('cards.list', { cards: [projectCard, card], total: 2 });
const cardDetail = parseOperatorResponse('cards.get', {
  card,
  children: [],
  ancestorIds: ['project-smoke'],
  evidence: {
    generatedFiles: [
      {
        path: 'reports/smoke-result.json',
        source: 'result.generated_files',
        exists: true,
        previewable: true,
        blocked: false,
        sensitivity: 'normal',
      },
    ],
    verificationCommands: [
      { command: 'npm run synthetic-smoke', process_id: 'proc-smoke', status: 'completed', exit_code: 0, timed_out: false },
    ],
    artifactPaths: ['reports/smoke-result.json'],
    toolErrors: [],
    summary: {
      state: 'present',
      summary: 'Synthetic evidence is present.',
      hasRecordedEvidence: true,
      hasDurableEvidence: true,
      missingCount: 0,
      blockedCount: 0,
      redactedCount: 0,
      fileCount: 1,
      verificationCount: 1,
      toolErrorCount: 0,
      parseRecovered: false,
    },
  },
  lifecycle: {
    status: 'done',
    terminal: true,
    phase: 'completed',
    explanation: 'Synthetic card completed.',
    completionState: 'marked-done',
    error: null,
    startedAt: now,
    completedAt: now,
    durationMs: 1000,
    retries: 0,
    childCounts: { drafting: 0, backlog: 0, active: 0, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
    hasActiveChildren: false,
    hasBlockingChildren: false,
    dependencyIds: [],
    blockedByDependencyIds: [],
  },
  review: { status: 'passed', review: null, evidenceStatus: 'recorded', summary: 'Synthetic review passed.' },
  planning: { status: 'done', summary: 'Synthetic planning done.', blockedReason: null, createdCardIds: [], updatedCardIds: [], reviewSummary: null, hasUnfinishedChildWork: false, plannerDeclaredDone: true },
  dispatches: { outgoing: [], incoming: [] },
});

const sessions = [
  { id: 'analyst-smoke', role: 'analyst', status: 'active', started_at: now, completed_at: null, model: 'synthetic-model' },
  { id: 'planner-smoke', role: 'planner', status: 'inactive', goal_card_id: 'project-smoke', card_id: 'card-smoke', started_at: now, completed_at: null, model: 'synthetic-model' },
  { id: 'reviewer-smoke', role: 'reviewer', status: 'inactive', goal_card_id: 'project-smoke', card_id: 'card-smoke', started_at: now, completed_at: now, model: 'synthetic-model' },
  { id: 'executor-smoke', role: 'executor', status: 'inactive', goal_card_id: 'project-smoke', card_id: 'card-smoke', started_at: now, completed_at: now, model: 'synthetic-model' },
];

const metaRoot = {
  path: '.saivage',
  files: [
    { name: 'runtime', path: '.saivage/runtime', type: 'directory', modifiedAt: now },
    { name: 'plan.json', path: '.saivage/plan.json', type: 'file', size: 32, modifiedAt: now },
  ],
};
const metaRuntime = {
  path: '.saivage/runtime',
  files: [{ name: 'events.jsonl', path: '.saivage/runtime/events.jsonl', type: 'file', size: 128, modifiedAt: now }],
};
const outputRoot = {
  path: '.saivage-work',
  files: [{ name: 'smoke-result.json', path: '.saivage-work/smoke-result.json', type: 'file', size: 64, modifiedAt: now }],
};

function stampedText(sessionId: string, id: string, content: string) {
  return { id, session_id: sessionId, role: 'assistant', kind: 'text', content, round_id: 'r-assistant-1', message_index: 0, block_index: 0, timestamp: now };
}

const idleActivity = { status: 'idle', pending_calls: [], updated_at: now };

export type OperatorRestObservations = {
  counts: Map<string, number>;
  unknown: string[];
};

function json(route: Route, payload: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

function keyFor(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`;
}

export async function installOperatorRestRoutes(page: Page): Promise<OperatorRestObservations> {
  const observations: OperatorRestObservations = { counts: new Map(), unknown: [] };

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = keyFor(request.method(), url.pathname);
    observations.counts.set(key, (observations.counts.get(key) ?? 0) + 1);

    if (request.method() === 'POST' && url.pathname === '/api/auth/ws-ticket') {
      return json(route, { ticket: 'synthetic-ws-ticket', expiresAt: '2026-05-19T12:05:00.000Z' });
    }
    if (request.method() === 'GET' && url.pathname === '/api/state') {
      return json(route, parseOperatorResponse('runtime.getState', { projectRoot: '/work/saivage-e2e-checkers', projectId: 'project', runtime: runtimeRunning, cardIndex: { total: 2, byStatus: { running: 1, done: 1 }, byType: { project: 1, code: 1 } } }));
    }
    if (request.method() === 'GET' && url.pathname === '/api/cards') return json(route, cardList);
    if (request.method() === 'GET' && url.pathname === '/api/cards/card-smoke') return json(route, cardDetail);
    if (request.method() === 'GET' && url.pathname === '/api/cards/card-smoke/history') return json(route, { history: [], total: 0 });
    if (request.method() === 'GET' && url.pathname === '/api/cards/card-smoke/history/3') return json(route, { entry: { ...card, snapshot: card } });
    if (request.method() === 'GET' && url.pathname === '/api/cards/card-smoke/diff') return json(route, { diff: [], from: 1, to: 3, card_id: 'card-smoke' });
    if (request.method() === 'GET' && url.pathname === '/api/agents') return json(route, { sessions });
    if (request.method() === 'GET' && url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/conversation')) {
      const sessionId = decodeURIComponent(url.pathname.split('/')[3] ?? 'analyst-smoke');
      return json(route, parseOperatorResponse('agents.conversation', {
        session: sessions.find((session) => session.id === sessionId) ?? sessions[0],
        entries: [stampedText(sessionId, `msg-${sessionId}-1`, 'Synthetic agent transcript.')],
        activity_status: idleActivity,
      }));
    }
    if (request.method() === 'GET' && url.pathname === '/api/files') {
      const path = url.searchParams.get('path');
      if (path === '.saivage/runtime') return json(route, metaRuntime);
      if (path === '.saivage-work' || !path) return json(route, path === '.saivage-work' ? outputRoot : metaRoot);
      if (path === '.saivage-work/quarantine') return json(route, { path, files: [] });
      return json(route, metaRoot);
    }
    if (request.method() === 'GET' && url.pathname === '/api/files/content') {
      return json(route, {
        path: url.searchParams.get('path') ?? '.saivage/plan.json',
        size: 32,
        contentType: 'application/json',
        content: JSON.stringify({ project: 'synthetic-project', stage: 'operator-playwright-smoke' }),
        redacted: false,
        sensitivity: 'normal',
      });
    }
    if (request.method() === 'GET' && url.pathname === '/api/debug/state') return json(route, { runtime: runtimeRunning, cards: [], totalCards: 0 });
    if (request.method() === 'GET' && url.pathname === '/api/debug/errors') {
      return json(route, { errors: [{ source: 'planner-smoke', type: 'invocation_failed', severity: 'error', message: 'Synthetic provider failure redacted', timestamp: now }], total: 1 });
    }
    if (request.method() === 'GET' && url.pathname === '/api/debug/timeline') {
      return json(route, { events: [{ id: 'evt-1', kind: 'model_selected', session_id: 'planner-smoke', timestamp: now, model: 'synthetic-model' }, { id: 'evt-2', kind: 'card_status_changed', card_id: 'card-smoke', timestamp: now, status: 'done' }], total: 2 });
    }
    if (request.method() === 'GET' && url.pathname === '/api/debug/doctor') return json(route, { status: 'ok', checks: [], issues: [] });
    if (request.method() === 'GET' && url.pathname === '/api/debug/supervision') return json(route, { reviews: [], quarantine: [], stats: { total: 0, blocked: 0, passed: 0, sanitized: 0, byRisk: {}, bySourceKind: {} } });
    if (request.method() === 'GET' && url.pathname === '/api/mcp/tools') return json(route, { tools: [], servers: [], invocationStats: {}, serverDetails: [] });
    if (request.method() === 'GET' && url.pathname === '/api/processes') return json(route, { processes: [] });
    if (request.method() === 'GET' && url.pathname === '/api/notifications') return json(route, { notifications: [], total: 0 });
    if (request.method() === 'GET' && url.pathname === '/api/control-actions') return json(route, { control_actions: [], total: 0 });
    if (request.method() === 'GET' && url.pathname === '/api/chats') return json(route, { sessions: [{ id: 'analyst-smoke', title: 'Synthetic analyst chat', updated_at: now }] });
    if (request.method() === 'GET' && url.pathname.startsWith('/api/chats/')) {
      const sessionId = decodeURIComponent(url.pathname.split('/')[3] ?? 'analyst-smoke');
      return json(route, parseOperatorResponse('chats.get', { sessionId, entries: [stampedText(sessionId, `chat-${sessionId}-1`, 'Synthetic agent transcript.')] }));
    }
    if (request.method() === 'POST' && url.pathname.startsWith('/api/chats/')) {
      const sessionId = decodeURIComponent(url.pathname.split('/')[3] ?? 'analyst-smoke');
      return json(route, { sessionId, message: { id: `chat-${sessionId}-outbound`, session_id: sessionId, role: 'user', kind: 'text', content: 'Synthetic outbound chat.', timestamp: now } });
    }

    observations.unknown.push(key);
    return json(route, { error: 'unknown_playwright_fixture_route', message: `No deterministic Playwright fixture for ${key}` }, 599);
  });

  return observations;
}
