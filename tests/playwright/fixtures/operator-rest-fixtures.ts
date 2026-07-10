import type { Page, Route } from '@playwright/test';
import { parseOperatorResponse } from '../../../src/contracts/operator-api.js';

const now = '2026-05-19T12:00:00.000Z';

const runtimeRunning = {
  status: 'running',
  project_id: 'project',
  pid: 4242,
  started_at: now,
  active_card_run: null,
  updated_at: now,
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
  lifecycle: { status: 'done', result: { kind: 'done', summary: 'synthetic result' }, error: null, completed_at: now },
  display_path: '1',
  operator_summary: { lifecycleStatus: 'done', terminal: true, blocked: false, hasError: false, error: null, completedAt: now, stale: false, actionCount: 0 },
  tags: ['smoke'],
  priority: 90,
  urgency: 'normal',
  created_by: 'user',
  created_at: now,
  updated_at: now,
  depends_on: [],
  related: [],
  acceptance: 'Synthetic acceptance only.',
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
  lifecycle: { status: 'running', result: null, error: null, completed_at: null },
  display_path: null,
  operator_summary: { lifecycleStatus: 'running', terminal: false, blocked: false, hasError: false, error: null, completedAt: null, stale: false, actionCount: 0 },
  result: null,
  version_seq: 1,
};

const cardList = parseOperatorResponse('cards.list', { cards: [projectCard, card], total: 2 });
const cardDetail = parseOperatorResponse('cards.get', {
  card,
  children: [],
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
    childCounts: { backlog: 0, running: 0, blocked: 0, changed: 0, done: 0, failed: 0, cancelled: 0 },
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

function stampedText(sessionId: string, id: string, content: string) {
  return { id, session_id: sessionId, role: 'assistant', kind: 'text', content, round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: now };
}

const idleActivity = { status: 'idle', pending_calls: [], updated_at: now };

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
      if (path === '.saivage/work/reports') return json(route, outputReports);
      if (path === '.saivage/work' || !path) return json(route, path === '.saivage/work' ? outputRoot : metaRoot);
      if (path === '.saivage/work/quarantine') return json(route, { path, files: [] });
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
    if (request.method() === 'GET' && url.pathname === '/api/debug/state') return json(route, { runtime: runtimeRunning, cards: [], totalCards: 0 });
    if (request.method() === 'GET' && url.pathname === '/api/debug/errors') {
      return json(route, { errors: [{ source: 'planner-smoke', type: 'runtime_diagnostic', severity: 'error', message: 'Synthetic provider failure redacted', timestamp: now }], total: 1 });
    }
    if (request.method() === 'GET' && url.pathname === '/api/debug/timeline') {
      return json(route, { events: [{ id: 'evt-1', kind: 'runtime_diagnostic', session_id: 'planner-smoke', timestamp: now, error_message: 'Synthetic provider failure redacted' }, { id: 'evt-2', kind: 'card_history_appended', card_id: 'card-smoke', timestamp: now, entry_id: '11111111-1111-4111-8111-111111111111', entry_kind: 'status', version_seq: 1, changed_fields: ['status'], changed_at: now }], total: 2 });
    }
    if (request.method() === 'GET' && url.pathname === '/api/debug/doctor') return json(route, { status: 'ok', checks: [], issues: [] });
    if (request.method() === 'GET' && url.pathname === '/api/debug/supervision') return json(route, { reviews: [], quarantine: [], stats: { total: 0, blocked: 0, passed: 0, sanitized: 0, byRisk: {}, bySourceKind: {} } });
    if (request.method() === 'GET' && url.pathname === '/api/mcp/tools') {
      return json(route, parseOperatorResponse('mcp.tools', {
        tools: [
          { name: 'read', description: 'Read a synthetic project file.', inputSchema: { type: 'object' } },
        ],
        servers: ['filesystem'],
        invocationStats: { 'filesystem:read': { total: 3, success: 2, error: 1, lastInvokedAt: now } },
        serverDetails: [{ name: 'filesystem', status: 'running', transport: 'stdio', toolCount: 1, tools: [{ name: 'read', description: 'Read a synthetic project file.', inputSchema: { type: 'object' }, stats: { total: 3, success: 2, error: 1, lastInvokedAt: now } }] }],
      }));
    }
    if (request.method() === 'GET' && url.pathname === '/api/processes') {
      return json(route, { processes: [{
        id: 'proc-smoke',
        status: 'completed',
        command: 'npm run synthetic-smoke',
        cwd: '/work/saivage-e2e-checkers',
        card_id: 'card-smoke',
        session_id: 'planner-smoke',
        owner_id: 'planner-smoke',
        owner_kind: 'agent',
        started_at: now,
        ended_at: now,
        exit_code: 0,
        timed_out: false,
        logs: { stdout: 'work:///processes/proc-smoke/stdout.log', stderr: 'work:///processes/proc-smoke/stderr.log' },
      }] });
    }
    if (request.method() === 'GET' && url.pathname === '/api/notifications') return json(route, { notifications: [], total: 0 });
    if (request.method() === 'GET' && url.pathname === '/api/control-actions') return json(route, { control_actions: [], total: 0 });
    if (request.method() === 'GET' && url.pathname === '/api/chats') return json(route, { sessions: [{ id: 'analyst:global', role: 'analyst', status: 'active', title: 'Synthetic analyst chat', started_at: now, completed_at: null, updated_at: now }] });
    if (request.method() === 'GET' && url.pathname.startsWith('/api/chats/')) {
      const sessionId = decodeURIComponent(url.pathname.split('/')[3] ?? 'analyst-smoke');
      return json(route, parseOperatorResponse('chats.get', {
        sessionId,
        entries: chatEntries.get(sessionId) ?? [stampedText(sessionId, `chat-${sessionId}-1`, 'Synthetic agent transcript.')],
      }));
    }
    if (request.method() === 'POST' && url.pathname.startsWith('/api/chats/')) {
      const sessionId = decodeURIComponent(url.pathname.split('/')[3] ?? 'analyst-smoke');
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
        toolInvocations: [],
      };
      chatEntries.set(sessionId, [stampedText(sessionId, `chat-${sessionId}-1`, 'Synthetic agent transcript.'), message]);
      return json(route, parseOperatorResponse('chats.send', {
        sessionId,
        message,
        toolInvocations: [],
      }));
    }

    observations.unknown.push(key);
    return json(route, { error: 'unknown_playwright_fixture_route', message: `No deterministic Playwright fixture for ${key}` }, 599);
  });

  return observations;
}
