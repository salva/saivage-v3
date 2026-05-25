import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readRuntimeState, updateRuntimeState } from '../../runtime/index.js';
import type { RuntimeState } from '../../schemas/index.js';
import type { ActiveRuntime } from '../../runtime/index.js';
import type { ProviderEntry, SaivageConfig } from '../../agents/index.js';
import { redactForOutbound } from '../../redaction/index.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateAuthz, type ActorRole, type SafetyClass } from '../../agents/index.js';
import { recordControlAction, stableStringify, listControlActions } from '../../persistence/index.js';
import { readFreezeManifest, clearFreezeManifest } from '../../runtime/index.js';
import { type ServerAvailability } from '../../contracts/index.js';
import { readLatestLlmExchange, LlmExchangeCorruptedError } from '../../agents/index.js';


function saivageDir(projectRoot: string): string { return `${projectRoot}/.saivage`; }
function actorFromRequest(_request: FastifyRequest): ActorRole { return 'user'; }
function paramsSummary(value: unknown): string { return stableStringify(value); }
function redactValue<T>(value: T): T {
  return redactForOutbound(value, 'operator.api', { source: 'runtime-config-notes.route' }) as T;
}

export interface MutatingRouteResult {
  statusCode?: number;
  body: unknown;
  ok: boolean;
  error?: string;
  outcomeSummary?: string;
}

export interface MutatingRouteOptions {
  request: FastifyRequest;
  reply: FastifyReply;
  projectRoot: string;
  action: string;
  safety_class: SafetyClass;
  target_kind: 'card' | 'note' | 'process' | 'runtime' | 'config' | 'session' | null;
  target_id: string | null;
  preview?: unknown;
  mutate: () => Promise<MutatingRouteResult>;
}

export async function runMutatingRoute(options: MutatingRouteOptions): Promise<FastifyReply> {
  const { request, reply, projectRoot, action, safety_class, target_kind, target_id, preview, mutate } = options;
  const actor = actorFromRequest(request);
  const surface = 'rest' as const;
  const paramsValue = { body: request.body, params: request.params };
  const auditBase = { actor, surface, action, target_kind, target_id, confirmed: true, params_summary: paramsSummary(paramsValue) };
  const verdict = evaluateAuthz({ actor, surface, safety_class });

  if (verdict === 'deny') {
    recordControlAction(projectRoot, { ...auditBase, outcome: 'denied', outcome_summary: 'authz denied' });
    return reply.status(403).send({ error: 'Denied by authorization policy.' });
  }

  if (verdict === 'preview_only') {
    recordControlAction(projectRoot, { ...auditBase, outcome: 'rejected', outcome_summary: 'preview-only authorization is not executable through confirmed/preview_hash mutation contracts' });
    return reply.status(403).send({ error: 'Action requires a directly authorized surface; confirmed/preview_hash confirmation is no longer accepted.', preview });
  }

  const result = await mutate();
  recordControlAction(projectRoot, {
    ...auditBase,
    outcome: result.ok ? 'ok' : 'error',
    outcome_summary: result.outcomeSummary ?? (result.ok ? 'mutation applied' : (result.error ?? 'mutation failed')),
    ...(result.ok ? {} : { error: result.error ?? 'mutation failed' }),
  });
  return reply.status(result.statusCode ?? (result.ok ? 200 : 500)).send(result.body);
}

function readAgentSession(projectRoot: string, sessionId: string): Record<string, unknown> | null { const sessionPath = join(projectRoot, '.saivage', 'agents', 'sessions', `${sessionId}.json`); if (!existsSync(sessionPath)) return null; try { return JSON.parse(readFileSync(sessionPath, 'utf-8')) as Record<string, unknown>; } catch { return null; } }
function readAgentMessages(projectRoot: string, sessionId: string): unknown[] { const messagesPath = join(projectRoot, '.saivage', 'agents', 'messages', `${sessionId}.jsonl`); if (!existsSync(messagesPath)) return []; const messages: unknown[] = []; for (const line of readFileSync(messagesPath, 'utf-8').split('\n')) if (line.trim()) try { messages.push(JSON.parse(line)); } catch { void 0; } return messages; }
const SAFE_AGENT_ID_RE = /^[a-zA-Z0-9_:-]+$/;

type ListedAgentStatus = 'active' | 'waiting' | 'inactive' | 'done' | 'blocked' | 'failed';

function listAgentMessageSessionIds(projectRoot: string): string[] {
  const messagesDir = join(projectRoot, '.saivage', 'agents', 'messages');
  if (!existsSync(messagesDir)) return [];
  return readdirSync(messagesDir)
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => file.slice(0, -'.jsonl'.length))
    .filter((sessionId) => SAFE_AGENT_ID_RE.test(sessionId));
}

function parseAgentRoleFromSessionId(sessionId: string): string {
  if (sessionId === 'analyst' || sessionId.startsWith('analyst-')) return 'analyst';
  if (sessionId.startsWith('planner:') || sessionId.startsWith('planner-')) return 'planner';
  if (sessionId.startsWith('reviewer:') || sessionId.startsWith('reviewer-')) return 'reviewer';
  if (sessionId.startsWith('executor:') || sessionId.startsWith('executor-')) return 'executor';
  if (sessionId.startsWith('card-')) return 'analyst';
  return 'analyst';
}

function firstMessageTimestamp(projectRoot: string, sessionId: string): string | null {
  const messages = readAgentMessages(projectRoot, sessionId);
  const first = messages.find((message): message is Record<string, unknown> => Boolean(message) && typeof message === 'object' && typeof (message as Record<string, unknown>)['timestamp'] === 'string');
  return typeof first?.['timestamp'] === 'string' ? first['timestamp'] : null;
}

function lastMessageTimestamp(projectRoot: string, sessionId: string): string | null {
  const messages = readAgentMessages(projectRoot, sessionId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === 'object') {
      const ts = (m as Record<string, unknown>)['timestamp'];
      if (typeof ts === 'string') return ts;
    }
  }
  return null;
}

function hasOpenPlannerRun(state: RuntimeState | null, sessionId: string): boolean {
  return (state?.runtime_runs ?? []).some((run) => run.session_id === sessionId && run.phase === 'planner' && run.runtime_status === 'running' && !run.finished_at);
}

function isActivePlannerTurn(state: RuntimeState | null, sessionId: string): boolean {
  const activeRun = state?.active_card_run;
  return activeRun?.phase === 'planner' && activeRun.planner_session_id === sessionId;
}

function listedStatus(state: RuntimeState | null, session: Record<string, unknown> | null, sessionId: string, currentSessionId: string | null): ListedAgentStatus {
  const openPlannerRun = hasOpenPlannerRun(state, sessionId);
  if (currentSessionId && sessionId === currentSessionId) return openPlannerRun && !isActivePlannerTurn(state, sessionId) ? 'waiting' : 'active';
  if (openPlannerRun) return 'waiting';
  const manifestStatus = session?.['status'];
  if (manifestStatus === 'active') return 'active';
  if (manifestStatus === 'waiting' || manifestStatus === 'done' || manifestStatus === 'blocked' || manifestStatus === 'failed') return manifestStatus;
  return 'inactive';
}

function buildListedAgentSession(projectRoot: string, sessionId: string, state: RuntimeState | null): Record<string, unknown> | null {
  if (!SAFE_AGENT_ID_RE.test(sessionId)) return null;
  const manifest = readAgentSession(projectRoot, sessionId);
  const startedAt = typeof manifest?.['started_at'] === 'string' ? manifest['started_at'] : firstMessageTimestamp(projectRoot, sessionId) ?? new Date(0).toISOString();
  return {
    ...(manifest ?? {}),
    id: sessionId,
    role: typeof manifest?.['role'] === 'string' ? manifest['role'] : parseAgentRoleFromSessionId(sessionId),
    status: listedStatus(state, manifest, sessionId, typeof state?.current_agent_session_id === 'string' ? state.current_agent_session_id : null),
    started_at: startedAt,
  };
}

export function registerRuntimeConfigNotesRoutes(fastify: FastifyInstance, projectRoot: string, activeRuntime?: ActiveRuntime, serverAvailabilityProvider?: () => ServerAvailability, saivageConfig?: SaivageConfig, configWarnings: readonly string[] = []): void {
  fastify.get('/api/control-actions', async (request, reply) => {
    try {
      const query = request.query as { card_id?: string; since?: string };
      const actions = listControlActions(projectRoot, { card_id: query.card_id, since: query.since }).map((entry) => redactValue(entry));
      return reply.send({ control_actions: actions, total: actions.length });
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to list control actions', message: err instanceof Error ? err.message : String(err) });
    }
  });
  fastify.post('/api/runtime/freeze', async (request, reply) => runMutatingRoute({ request, reply, projectRoot, action: 'runtime.freeze', safety_class: 'destructive', target_kind: 'runtime', target_id: 'project', mutate: async () => { try { const body = request.body as { reason?: string } | undefined; const reason = body?.reason; if (activeRuntime) { const manifest = activeRuntime.freeze(reason); return { ok: true, body: { status: 'frozen', freeze_id: manifest.freeze_id, reason: manifest.reason, created_at: manifest.created_at } }; } const existing = readFreezeManifest(projectRoot); if (existing) return { ok: true, body: { status: 'already_frozen', freeze_id: existing.freeze_id, reason: existing.reason, created_at: existing.created_at } }; const state = readRuntimeState(projectRoot); if (!state) return { ok: false, statusCode: 400, error: 'Cannot freeze: runtime state not initialized.', body: { error: 'Cannot freeze: runtime state not initialized.' } }; const now = new Date().toISOString(); updateRuntimeState(projectRoot, { status: 'frozen', paused: true, paused_at: now, frozen_reason: reason ?? 'operator requested freeze' }); return { ok: true, body: { status: 'frozen', freeze_id: 'persisted-freeze', reason: reason ?? 'operator requested freeze', created_at: now } }; } catch (err) { return { ok: false, statusCode: 500, error: err instanceof Error ? err.message : String(err), body: { error: 'Failed to freeze runtime', message: err instanceof Error ? err.message : String(err) } }; } } }));
  fastify.post('/api/runtime/resume-from-freeze', async (request, reply) => runMutatingRoute({ request, reply, projectRoot, action: 'runtime.resume_from_freeze', safety_class: 'destructive', target_kind: 'runtime', target_id: 'project', mutate: async () => { try { if (activeRuntime) { const result = activeRuntime.resumeFromFreeze(); return { ok: true, body: { status: 'resumed', freeze_id: result.freeze_id, restored_queue: result.restored_queue, restored_processes: result.restored_processes, restored_card_id: result.restored_card_id } }; } const manifest = readFreezeManifest(projectRoot); if (!manifest) return { ok: false, statusCode: 400, error: 'Cannot resume from freeze: no freeze manifest found. The runtime is not frozen.', body: { error: 'Cannot resume from freeze: no freeze manifest found. The runtime is not frozen.' } }; updateRuntimeState(projectRoot, { status: 'idle', current_card_id: manifest.current_card_id, current_agent_session_id: manifest.current_agent_session_id, paused: false, paused_at: null, queue: manifest.queue, running_processes: [], frozen_reason: null }); clearFreezeManifest(projectRoot); return { ok: true, body: { status: 'resumed', freeze_id: manifest.freeze_id, restored_queue: manifest.queue, restored_processes: [], restored_card_id: manifest.current_card_id } }; } catch (err) { return { ok: false, statusCode: 500, error: err instanceof Error ? err.message : String(err), body: { error: 'Failed to resume from freeze', message: err instanceof Error ? err.message : String(err) } }; } } }));
  fastify.get('/api/config', async (_request, reply) => { if (!saivageConfig) return reply.status(500).send({ error: 'Configuration unavailable', message: 'Server was not started with a validated Environment config.' }); const config = redactForOutbound(saivageConfig, 'operator.api', { source: 'runtime-config-notes.config' }); return reply.send({ config, warnings: configWarnings }); });
  fastify.get('/api/providers', async (_request, reply) => { if (!saivageConfig) return reply.status(500).send({ error: 'Providers unavailable', message: 'Server was not started with a validated Environment config.' }); const providers: Record<string, unknown> = {}; for (const [name, provider] of Object.entries(saivageConfig.providers)) { const p = provider as ProviderEntry; providers[name] = { priority: p.priority, models: p.models, baseUrl: p.baseUrl, hasAccounts: p.accounts ? Object.keys(p.accounts).length : 0, status: 'unknown' }; } return reply.send({ providers }); });
  fastify.get('/api/agents', async (_request, reply) => { try { const sessionsDir = join(projectRoot, '.saivage', 'agents', 'sessions'); const sessionIds = new Set<string>(listAgentMessageSessionIds(projectRoot)); if (existsSync(sessionsDir)) { for (const file of readdirSync(sessionsDir).filter((entry) => entry.endsWith('.json'))) sessionIds.add(file.slice(0, -'.json'.length)); } const state = readRuntimeState(projectRoot); const sessions = Array.from(sessionIds).map((sessionId) => buildListedAgentSession(projectRoot, sessionId, state)).filter((session): session is Record<string, unknown> => Boolean(session)); sessions.sort((a, b) => String(b['started_at'] ?? '').localeCompare(String(a['started_at'] ?? '')) || String(a['id']).localeCompare(String(b['id']))); return reply.send({ sessions }); } catch (err) { return reply.status(500).send({ error: 'Failed to list agent sessions', message: err instanceof Error ? err.message : String(err) }); } });
  fastify.get('/api/agents/:id', async (request, reply) => { try { const params = request.params as { id: string }; const sessionId = params.id; if (!SAFE_AGENT_ID_RE.test(sessionId)) return reply.status(400).send({ error: 'Invalid agent session ID' }); const manifest = readAgentSession(projectRoot, sessionId); const messages = readAgentMessages(projectRoot, sessionId); if (!manifest && messages.length === 0) return reply.status(404).send({ error: 'Agent session not found', sessionId }); const base = buildListedAgentSession(projectRoot, sessionId, readRuntimeState(projectRoot)) ?? { id: sessionId, role: parseAgentRoleFromSessionId(sessionId), status: 'inactive', started_at: new Date(0).toISOString() }; const lastActivity = lastMessageTimestamp(projectRoot, sessionId) ?? (typeof manifest?.['completed_at'] === 'string' ? (manifest['completed_at'] as string) : null) ?? (typeof base['started_at'] === 'string' ? (base['started_at'] as string) : null); const session = { ...base, message_count: messages.length, last_activity_at: lastActivity }; return reply.send({ session }); } catch (err) { return reply.status(500).send({ error: 'Failed to read agent session', message: err instanceof Error ? err.message : String(err) }); } });
  fastify.get('/api/agents/:id/conversation', async (request, reply) => { try { const params = request.params as { id: string }; const sessionId = params.id; if (!SAFE_AGENT_ID_RE.test(sessionId)) return reply.status(400).send({ error: 'Invalid agent session ID' }); const messages = readAgentMessages(projectRoot, sessionId); const session = buildListedAgentSession(projectRoot, sessionId, readRuntimeState(projectRoot)); if (!session || (messages.length === 0 && !readAgentSession(projectRoot, sessionId))) return reply.status(404).send({ error: 'Agent session not found', sessionId }); return reply.send({ session, messages }); } catch (err) { return reply.status(500).send({ error: 'Failed to read agent conversation', message: err instanceof Error ? err.message : String(err) }); } });
  fastify.get('/api/agents/:id/llm-exchange', async (request, reply) => {
    const params = request.params as { id: string };
    const sessionId = params.id;
    if (!SAFE_AGENT_ID_RE.test(sessionId)) return reply.status(400).send({ error: 'Invalid agent session ID' });
    try {
      const exchange = await readLatestLlmExchange(saivageDir(projectRoot), sessionId);
      if (!exchange) return reply.status(404).send({ error: 'No LLM exchange recorded for this session yet.' });
      return reply.send({ exchange });
    } catch (err) {
      if (err instanceof LlmExchangeCorruptedError) {
        request.log.error({ err, sessionId, cause: err.cause }, 'Corrupted LLM exchange record');
        return reply.status(500).send({ error: 'Corrupted LLM exchange record.' });
      }
      return reply.status(500).send({ error: 'Failed to read LLM exchange', message: err instanceof Error ? err.message : String(err) });
    }
  });
}
// Source-anchor preservation: runtime control routes moved to ContractRuntime.
