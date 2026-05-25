import type { FastifyInstance } from 'fastify';
import { readRuntimeState } from '../../runtime/index.js';
import type { RuntimeState } from '../../schemas/index.js';
import type { ActiveRuntime } from '../../runtime/index.js';
import type { ProviderEntry, SaivageConfig } from '../../agents/index.js';
import { redactForOutbound } from '../../redaction/index.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listControlActions } from '../../persistence/index.js';
import { type ServerAvailability } from '../../contracts/index.js';
import { readLatestLlmExchange, LlmExchangeCorruptedError } from '../../agents/index.js';


function saivageDir(projectRoot: string): string { return `${projectRoot}/.saivage`; }
function redactValue<T>(value: T): T {
  return redactForOutbound(value, 'operator.api', { source: 'runtime-config-notes.route' }) as T;
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
