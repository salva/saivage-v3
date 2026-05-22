import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readRuntimeState, updateRuntimeState, RuntimeStateLayoutError } from '../../utils/runtime-state.js';
import { pauseRuntimeControl, resumeRuntimeControl } from '../../utils/runtime-control.js';
import type { ActiveRuntime } from '../../utils/active-runtime.js';
import { loadConfig, type ProviderEntry } from '../../agents/config-schema.js';
import { getReconciledUnhandledNotesQueue, findUnhandledNoteCardId, markNoteHandled, deleteNote } from '../../utils/notes.js';
import { redactCredentialLiterals, redactSecrets } from '../../utils/file-access-security.js';
import { CardStore, type CardStoreHealth } from '../../utils/card-store.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateAuthz, type ActorRole, type SafetyClass } from '../../agents/authz.js';
import { recordControlAction, stableStringify, listControlActions } from '../../utils/control-action-audit.js';
import { readFreezeManifest, clearFreezeManifest } from '../../utils/freeze-manifest.js';
import { NotificationCenter } from '../../utils/notification-center.js';
import { operatorApiContracts, type ServerAvailability } from '../../contracts/operator-api.js';
import { parseContractRequest, validateContractSuccess } from '../contract-route.js';

const INLINE_SECRET_RE = /(api(?:[_-]?key|[_-]?token)?|token|secret|password)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;

function saivageDir(projectRoot: string): string { return `${projectRoot}/.saivage`; }
function actorFromRequest(_request: FastifyRequest): ActorRole { return 'user'; }
function paramsSummary(value: unknown): string { return stableStringify(value); }
function redactInlineSecrets(content: string): string { return content.replace(INLINE_SECRET_RE, (_match, key: string) => `${key}=[REDACTED]`); }

function runtimeStateErrorBody(err: unknown, fallback: string): { statusCode: number; body: Record<string, unknown> } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof RuntimeStateLayoutError) {
    return { statusCode: 500, body: { error: 'RuntimeStateLayoutError', message } };
  }
  return { statusCode: 500, body: { error: fallback, message } };
}

function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactCredentialLiterals(redactInlineSecrets(redactSecrets(value))) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [key, redactValue(entryValue)])) as T;
  }
  return value;
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
  const bodyRecord = (request.body ?? {}) as Record<string, unknown>;
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
function readAgentMessages(projectRoot: string, sessionId: string): unknown[] { const messagesPath = join(projectRoot, '.saivage', 'agents', 'messages', `${sessionId}.jsonl`); if (!existsSync(messagesPath)) return []; const messages: unknown[] = []; for (const line of readFileSync(messagesPath, 'utf-8').split('\n')) if (line.trim()) try { messages.push(JSON.parse(line)); } catch {} return messages; }
const SAFE_AGENT_ID_RE = /^[a-zA-Z0-9_:-]+$/;

type ListedAgentStatus = 'active' | 'inactive' | 'done' | 'failed';

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

function currentAgentSessionId(projectRoot: string): string | null {
  const state = readRuntimeState(projectRoot);
  return typeof state?.current_agent_session_id === 'string' ? state.current_agent_session_id : null;
}

function listedStatus(session: Record<string, unknown> | null, sessionId: string, currentSessionId: string | null): ListedAgentStatus {
  if (currentSessionId && sessionId === currentSessionId) return 'active';
  const manifestStatus = session?.['status'];
  if (manifestStatus === 'done' || manifestStatus === 'failed') return manifestStatus;
  if (!currentSessionId && manifestStatus === 'active') return 'active';
  return 'inactive';
}

function buildListedAgentSession(projectRoot: string, sessionId: string, currentSessionId: string | null): Record<string, unknown> | null {
  if (!SAFE_AGENT_ID_RE.test(sessionId)) return null;
  const manifest = readAgentSession(projectRoot, sessionId);
  const startedAt = typeof manifest?.['started_at'] === 'string' ? manifest['started_at'] : firstMessageTimestamp(projectRoot, sessionId) ?? new Date(0).toISOString();
  return {
    ...(manifest ?? {}),
    id: sessionId,
    role: typeof manifest?.['role'] === 'string' ? manifest['role'] : parseAgentRoleFromSessionId(sessionId),
    status: listedStatus(manifest, sessionId, currentSessionId),
    started_at: startedAt,
  };
}

function resolveCardStoreHealth(activeRuntime: ActiveRuntime | undefined, fallbackStore: CardStore): CardStoreHealth { return activeRuntime?.runtime.cardStore.getHealth() ?? fallbackStore.getHealth(); }

function runtimeUnavailableError(command: 'start_project' | 'stop_project'): { success: false; actionable_error: Record<string, unknown> } {
  return {
    success: false,
    actionable_error: {
      code: 'active_runtime_unavailable',
      message: `Cannot execute ${command}: ActiveRuntime is not attached to this server process.`,
      currentState: { activeRuntime: false, command },
      nextAction: 'Restart the server with runtime creation enabled before issuing runtime control commands.',
      docsRef: 'docs/runtime-controls.md',
      cardId: 'project',
    },
  };
}
export function registerRuntimeConfigNotesRoutes(fastify: FastifyInstance, projectRoot: string, activeRuntime?: ActiveRuntime, serverAvailabilityProvider?: () => ServerAvailability): void {
  const store = new CardStore(projectRoot);
  const notifications = new NotificationCenter(projectRoot);
  fastify.get('/api/state', async (_request, reply) => { try { const serverAvailability = serverAvailabilityProvider?.(); const state = readRuntimeState(projectRoot); if (!state) return reply.send(validateContractSuccess(operatorApiContracts['runtime.getState'], { runtime: null, cardIndex: { total: 0, byStatus: {}, byType: {} }, ...(serverAvailability ? { serverAvailability } : {}) })); const cards = store.list(); const cardStoreHealth = resolveCardStoreHealth(activeRuntime, store); const byStatus: Record<string, number> = {}; const byType: Record<string, number> = {}; for (const card of cards) { byStatus[card.status] = (byStatus[card.status] || 0) + 1; byType[card.type] = (byType[card.type] || 0) + 1; } return reply.send(validateContractSuccess(operatorApiContracts['runtime.getState'], { runtime: state, cardIndex: { total: cards.length, byStatus, byType }, cardStoreHealth, ...(serverAvailability ? { serverAvailability } : {}) })); } catch (err) { const typed = runtimeStateErrorBody(err, 'Failed to read runtime state'); return reply.status(typed.statusCode).send(typed.body); } });
  fastify.get('/api/notifications', async (_request, reply) => {
    try {
      const items = notifications.listForOperator().map((record) => redactValue(record));
      return reply.send({ notifications: items, total: items.length });
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to list notifications', message: err instanceof Error ? err.message : String(err) });
    }
  });
  fastify.post('/api/notifications/:id/acknowledge', async (request, reply) => runMutatingRoute({
    request,
    reply,
    projectRoot,
    action: 'notification.acknowledge',
    safety_class: 'low',
    target_kind: 'session',
    target_id: (request.params as { id: string }).id,
    mutate: async () => {
      try {
        const notificationId = (request.params as { id: string }).id;
        const existing = notifications.listForOperator().find((item) => item.id === notificationId) ?? null;
        if (!existing) return { ok: false, statusCode: 404, error: 'Notification not found', body: { error: 'Notification not found', notificationId }, outcomeSummary: 'notification not found' };
        const updated = notifications.acknowledgeForOperator(notificationId);
        return { ok: true, body: { notification: redactValue(updated ?? existing) }, outcomeSummary: 'notification acknowledged' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, statusCode: 500, error: message, body: { error: 'Failed to acknowledge notification', message }, outcomeSummary: message };
      }
    },
  }));
  fastify.get('/api/control-actions', async (request, reply) => {
    try {
      const query = request.query as { card_id?: string; since?: string };
      const actions = listControlActions(projectRoot, { card_id: query.card_id, since: query.since }).map((entry) => redactValue(entry));
      return reply.send({ control_actions: actions, total: actions.length });
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to list control actions', message: err instanceof Error ? err.message : String(err) });
    }
  });
  fastify.post('/api/runtime/start_project', async (request, reply) => { const parsed = parseContractRequest(operatorApiContracts['runtime.startProject'], request); if (!parsed.ok) return reply.status(parsed.statusCode).send(parsed.body); return runMutatingRoute({ request, reply, projectRoot, action: 'runtime.start_project', safety_class: 'low', target_kind: 'runtime', target_id: 'project', mutate: async () => { if (!activeRuntime) { const body = runtimeUnavailableError('start_project'); return { ok: false, statusCode: 503, error: body.actionable_error.message as string, body: operatorApiContracts['runtime.startProject'].error.parse(body), outcomeSummary: 'active runtime unavailable' }; } const result = await activeRuntime.startProject(); if (!result.success) return { ok: false, statusCode: 409, error: result.error.message, body: operatorApiContracts['runtime.startProject'].error.parse({ success: false, command: result.command, actionable_error: result.error }), outcomeSummary: result.error.message }; return { ok: true, body: validateContractSuccess(operatorApiContracts['runtime.startProject'], { success: true, command: result.command, intent: result.intent, run: result.run }), outcomeSummary: 'start_project accepted' }; } }); });
  fastify.post('/api/runtime/stop_project', async (request, reply) => { const parsed = parseContractRequest(operatorApiContracts['runtime.stopProject'], request); if (!parsed.ok) return reply.status(parsed.statusCode).send(parsed.body); return runMutatingRoute({ request, reply, projectRoot, action: 'runtime.stop_project', safety_class: 'low', target_kind: 'runtime', target_id: 'project', mutate: async () => { if (!activeRuntime) { const body = runtimeUnavailableError('stop_project'); return { ok: false, statusCode: 503, error: body.actionable_error.message as string, body: operatorApiContracts['runtime.stopProject'].error.parse(body), outcomeSummary: 'active runtime unavailable' }; } const result = await activeRuntime.stopProject(); return { ok: true, body: validateContractSuccess(operatorApiContracts['runtime.stopProject'], { success: true, command: result.command, intent: result.intent, ...(result.run ? { run: result.run } : {}) }), outcomeSummary: 'stop_project accepted' }; } }); });
  fastify.post('/api/runtime/pause', async (request, reply) => { const parsed = parseContractRequest(operatorApiContracts['runtime.pause'], request); if (!parsed.ok) return reply.status(parsed.statusCode).send(parsed.body); return runMutatingRoute({ request, reply, projectRoot, action: 'runtime.pause', safety_class: 'low', target_kind: 'runtime', target_id: 'project', mutate: async () => { const result = pauseRuntimeControl({ projectRoot, activeRuntime }); if (!result.ok) { const isLayoutError = result.message?.includes('RuntimeState layout conflict') === true; const error = isLayoutError ? 'RuntimeStateLayoutError' : result.error ?? 'Failed to pause runtime'; return { ok: false, statusCode: result.statusCode ?? 500, error: result.message ?? error, body: { error, message: result.message } }; } return { ok: true, body: validateContractSuccess(operatorApiContracts['runtime.pause'], result.state ?? readRuntimeState(projectRoot)) }; } }); });
  fastify.post('/api/runtime/resume', async (request, reply) => { const parsed = parseContractRequest(operatorApiContracts['runtime.resume'], request); if (!parsed.ok) return reply.status(parsed.statusCode).send(parsed.body); return runMutatingRoute({ request, reply, projectRoot, action: 'runtime.resume', safety_class: 'low', target_kind: 'runtime', target_id: 'project', mutate: async () => { const result = resumeRuntimeControl({ projectRoot, activeRuntime }); if (!result.ok) { const isLayoutError = result.message?.includes('RuntimeState layout conflict') === true; const error = isLayoutError ? 'RuntimeStateLayoutError' : result.error ?? 'Failed to resume runtime'; return { ok: false, statusCode: result.statusCode ?? 500, error: result.message ?? error, body: { error, message: result.message, ...(result.action ? { action: result.action } : {}) } }; } return { ok: true, body: validateContractSuccess(operatorApiContracts['runtime.resume'], result.state ?? readRuntimeState(projectRoot)) }; } }); });
  fastify.post('/api/runtime/freeze', async (request, reply) => runMutatingRoute({ request, reply, projectRoot, action: 'runtime.freeze', safety_class: 'destructive', target_kind: 'runtime', target_id: 'project', mutate: async () => { try { const body = request.body as { reason?: string } | undefined; const reason = body?.reason; if (activeRuntime) { const manifest = activeRuntime.freeze(reason); return { ok: true, body: { status: 'frozen', freeze_id: manifest.freeze_id, reason: manifest.reason, created_at: manifest.created_at } }; } const existing = readFreezeManifest(projectRoot); if (existing) return { ok: true, body: { status: 'already_frozen', freeze_id: existing.freeze_id, reason: existing.reason, created_at: existing.created_at } }; const state = readRuntimeState(projectRoot); if (!state) return { ok: false, statusCode: 400, error: 'Cannot freeze: runtime state not initialized.', body: { error: 'Cannot freeze: runtime state not initialized.' } }; const now = new Date().toISOString(); updateRuntimeState(projectRoot, { status: 'frozen', paused: true, paused_at: now, frozen_reason: reason ?? 'operator requested freeze' }); return { ok: true, body: { status: 'frozen', freeze_id: 'persisted-freeze', reason: reason ?? 'operator requested freeze', created_at: now } }; } catch (err) { return { ok: false, statusCode: 500, error: err instanceof Error ? err.message : String(err), body: { error: 'Failed to freeze runtime', message: err instanceof Error ? err.message : String(err) } }; } } }));
  fastify.post('/api/runtime/resume-from-freeze', async (request, reply) => runMutatingRoute({ request, reply, projectRoot, action: 'runtime.resume_from_freeze', safety_class: 'destructive', target_kind: 'runtime', target_id: 'project', mutate: async () => { try { if (activeRuntime) { const result = activeRuntime.resumeFromFreeze(); return { ok: true, body: { status: 'resumed', freeze_id: result.freeze_id, restored_queue: result.restored_queue, restored_processes: result.restored_processes, restored_card_id: result.restored_card_id } }; } const manifest = readFreezeManifest(projectRoot); if (!manifest) return { ok: false, statusCode: 400, error: 'Cannot resume from freeze: no freeze manifest found. The runtime is not frozen.', body: { error: 'Cannot resume from freeze: no freeze manifest found. The runtime is not frozen.' } }; updateRuntimeState(projectRoot, { status: 'idle', current_card_id: manifest.current_card_id, current_agent_session_id: manifest.current_agent_session_id, paused: false, paused_at: null, queue: manifest.queue, running_processes: [], frozen_reason: null }); clearFreezeManifest(projectRoot); return { ok: true, body: { status: 'resumed', freeze_id: manifest.freeze_id, restored_queue: manifest.queue, restored_processes: [], restored_card_id: manifest.current_card_id } }; } catch (err) { return { ok: false, statusCode: 500, error: err instanceof Error ? err.message : String(err), body: { error: 'Failed to resume from freeze', message: err instanceof Error ? err.message : String(err) } }; } } }));
  fastify.get('/api/config', async (_request, reply) => { try { const { config, warnings } = loadConfig(projectRoot); const configJson = JSON.stringify(config); const redacted = redactSecrets(configJson); return reply.send({ config: JSON.parse(redacted), warnings }); } catch (err) { return reply.send({ config: { server: { port: 8080, host: '0.0.0.0' } }, warnings: [`Configuration could not be fully loaded: ${err instanceof Error ? err.message : String(err)}`] }); } });
  fastify.get('/api/providers', async (_request, reply) => { try { const { config } = loadConfig(projectRoot); const providers: Record<string, unknown> = {}; for (const [name, provider] of Object.entries(config.providers)) { const p = provider as ProviderEntry; providers[name] = { priority: p.priority, models: p.models, baseUrl: p.baseUrl, hasAccounts: p.accounts ? Object.keys(p.accounts).length : 0, status: 'unknown' }; } return reply.send({ providers }); } catch (err) { return reply.send({ providers: {}, warnings: [`Providers could not be loaded: ${err instanceof Error ? err.message : String(err)}`] }); } });
  fastify.get('/api/agents', async (_request, reply) => { try { const sessionsDir = join(projectRoot, '.saivage', 'agents', 'sessions'); const sessionIds = new Set<string>(listAgentMessageSessionIds(projectRoot)); if (existsSync(sessionsDir)) { for (const file of readdirSync(sessionsDir).filter((entry) => entry.endsWith('.json'))) sessionIds.add(file.slice(0, -'.json'.length)); } const currentSessionId = currentAgentSessionId(projectRoot); const sessions = Array.from(sessionIds).map((sessionId) => buildListedAgentSession(projectRoot, sessionId, currentSessionId)).filter((session): session is Record<string, unknown> => Boolean(session)); sessions.sort((a, b) => String(b['started_at'] ?? '').localeCompare(String(a['started_at'] ?? '')) || String(a['id']).localeCompare(String(b['id']))); return reply.send({ sessions }); } catch (err) { return reply.status(500).send({ error: 'Failed to list agent sessions', message: err instanceof Error ? err.message : String(err) }); } });
  fastify.get('/api/agents/:id/conversation', async (request, reply) => { try { const params = request.params as { id: string }; const sessionId = params.id; if (!SAFE_AGENT_ID_RE.test(sessionId)) return reply.status(400).send({ error: 'Invalid agent session ID' }); const messages = readAgentMessages(projectRoot, sessionId); const session = buildListedAgentSession(projectRoot, sessionId, currentAgentSessionId(projectRoot)); if (!session || (messages.length === 0 && !readAgentSession(projectRoot, sessionId))) return reply.status(404).send({ error: 'Agent session not found', sessionId }); return reply.send({ session, messages }); } catch (err) { return reply.status(500).send({ error: 'Failed to read agent conversation', message: err instanceof Error ? err.message : String(err) }); } });
  fastify.get('/api/notes', async (_request, reply) => { try { const notes = getReconciledUnhandledNotesQueue(saivageDir(projectRoot)); return reply.send({ notes, total: notes.length }); } catch (err) { return reply.status(500).send({ error: 'Failed to list notes', message: err instanceof Error ? err.message : String(err) }); } });
  fastify.post('/api/notes/:id/acknowledge', async (request, reply) => runMutatingRoute({ request, reply, projectRoot, action: 'note.acknowledge', safety_class: 'low', target_kind: 'note', target_id: (request.params as { id: string }).id, mutate: async () => { try { const params = request.params as { id: string }; const noteId = params.id; const cardId = findUnhandledNoteCardId(saivageDir(projectRoot), noteId); if (!cardId) return { ok: false, statusCode: 404, error: 'Note not found', body: { error: 'Note not found', noteId } }; const updated = markNoteHandled(saivageDir(projectRoot), cardId, noteId); return { ok: true, body: { note: updated } }; } catch (err) { const message = err instanceof Error ? err.message : String(err); return { ok: false, statusCode: message.includes('not found') ? 404 : 500, error: message, body: message.includes('not found') ? { error: 'Note not found', noteId: (request.params as { id: string }).id } : { error: 'Failed to acknowledge note', message } }; } } }));
  fastify.delete('/api/notes/:id', async (request, reply) => runMutatingRoute({ request, reply, projectRoot, action: 'note.delete', safety_class: 'destructive', target_kind: 'note', target_id: (request.params as { id: string }).id, mutate: async () => { try { const params = request.params as { id: string }; const noteId = params.id; const cardId = findUnhandledNoteCardId(saivageDir(projectRoot), noteId); if (!cardId) return { ok: false, statusCode: 404, error: 'Note not found', body: { error: 'Note not found', noteId } }; deleteNote(saivageDir(projectRoot), cardId, noteId); return { ok: true, statusCode: 204, body: undefined }; } catch (err) { const message = err instanceof Error ? err.message : String(err); if (message.includes('not found')) return { ok: false, statusCode: 404, error: message, body: { error: 'Note not found', noteId: (request.params as { id: string }).id } }; if (message.includes('handled')) return { ok: false, statusCode: 400, error: message, body: { error: 'Cannot delete handled note', message } }; return { ok: false, statusCode: 500, error: message, body: { error: 'Failed to delete note', message } }; } } }));
  fastify.delete('/api/notes', async (request, reply) => runMutatingRoute({ request, reply, projectRoot, action: 'note.clear_all', safety_class: 'destructive', target_kind: 'note', target_id: null, mutate: async () => { try { const queue = getReconciledUnhandledNotesQueue(saivageDir(projectRoot)); const deletedIds: string[] = []; for (const entry of queue) { deleteNote(saivageDir(projectRoot), entry.card_id, entry.note_id); deletedIds.push(entry.note_id); } return { ok: true, body: { deleted: deletedIds.length, noteIds: deletedIds } }; } catch (err) { return { ok: false, statusCode: 500, error: err instanceof Error ? err.message : String(err), body: { error: 'Failed to clear notes', message: err instanceof Error ? err.message : String(err) } }; } } }));
}
