import type { FastifyInstance } from 'fastify';
import { CardStore } from '../../utils/card-store.js';
import type { CardRecord, CardStatus, CardType, CardHistoryEntry } from '../../schemas/types.js';
import { operatorApiContracts } from '../../contracts/operator-api.js';
import { allowedActions } from '../../permissions/index.js';
import { readRuntimeState } from '../../runtime/state.js';
import { pauseRuntimeControl, resumeRuntimeControl } from '../../runtime/control.js';
import type { ActiveRuntime } from '../../runtime/lifecycle.js';
import { buildServerAvailability, type ServerAvailabilityInputs } from '../availability.js';
import { ContractRuntime, type ContractHandler } from '../contract-runtime.js';
import { runMutatingRoute } from './runtime-config-notes.js';
import { redactForOutbound } from '../../redaction/index.js';

const TRACKED_UPDATE_FIELDS = new Set(['title','description','acceptance','depends_on','related','estimate','parent','assigned_to','type','subtype','instructions_file','tags','priority','urgency']);

function withOperatorAllowedActions(card: CardRecord): CardRecord {
  return { ...card, allowedActions: allowedActions('operator', card.status) };
}


function redactValue<T>(value: T): T {
  return redactForOutbound(value, 'operator.api', { source: 'operator-contracts.cards' }) as T;
}

function historyHeader(entry: CardHistoryEntry) {
  return {
    card_id: entry.card_id,
    version_seq: entry.version_seq,
    changed_at: entry.changed_at,
    changed_by_actor: entry.changed_by_actor,
    changed_by_surface: entry.changed_by_surface,
    change_reason: entry.change_reason,
    changed_fields: entry.changed_fields,
    change_summary: entry.change_summary,
  };
}

function runtimeUnavailableError(command: 'start_project' | 'stop_project'): { success: false; actionable_error: Record<string, unknown> } {
  return { success: false, actionable_error: { code: 'active_runtime_unavailable', message: `Cannot ${command}: ActiveRuntime is not running in this server process.`, nextAction: 'Start the server with runtime creation enabled or retry after runtime startup succeeds.' } };
}

function inputDefaults(): Omit<CardRecord, 'id' | 'created_at' | 'updated_at' | 'version_seq'> {
  return { type: 'code', parent: null, depth: 0, title: '', description: '', status: 'backlog', subtype: null, instructions_file: null, tags: [], priority: 0, urgency: 'normal', created_by: 'user', assigned_to: null, depends_on: [], blocks: [], related: [], acceptance: '', result: null, metrics: null, artifacts: [], attachments: [], estimate: null, started_at: null, completed_at: null, duration_ms: null, error: null, retries: 0 };
}

export function registerOperatorContractRoutes(options: {
  fastify: FastifyInstance;
  projectRoot: string;
  activeRuntime?: ActiveRuntime;
  activeRuntimeProvider?: () => ActiveRuntime | undefined;
  serverAvailabilityProvider?: () => ReturnType<typeof buildServerAvailability>;
}): void {
  const { fastify, projectRoot } = options;
  const runtime = new ContractRuntime();
  const store = new CardStore(projectRoot);
  const getActiveRuntime = () => options.activeRuntimeProvider?.() ?? options.activeRuntime;

  const handlers: Partial<Record<keyof typeof operatorApiContracts, ContractHandler>> = {
    'health.liveness': () => ({ body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' } }),
    'health.readiness': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      return { statusCode: 200, body: { status: 'ready', ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'runtime.getState': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      const state = readRuntimeState(projectRoot);
      if (!state) return { body: { runtime: null, cardIndex: { total: 0, byStatus: {}, byType: {} }, ...(serverAvailability ? { serverAvailability } : {}) } };
      const cards = store.list();
      const byStatus: Record<string, number> = {};
      const byType: Record<string, number> = {};
      for (const card of cards) { byStatus[card.status] = (byStatus[card.status] || 0) + 1; byType[card.type] = (byType[card.type] || 0) + 1; }
      return { body: { runtime: state, cardIndex: { total: cards.length, byStatus, byType }, cardStoreHealth: { canonical: 'ok' }, ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'runtime.startProject': ({ request, reply }) => runMutatingRoute({ request, reply, projectRoot, action: 'runtime.start_project', safety_class: 'low', target_kind: 'runtime', target_id: 'project', mutate: async () => {
      const activeRuntime = getActiveRuntime();
      if (!activeRuntime) { const body = runtimeUnavailableError('start_project'); return { ok: false, statusCode: 503, error: body.actionable_error.message as string, body: operatorApiContracts['runtime.startProject'].error.parse(body), outcomeSummary: 'active runtime unavailable' }; }
      const result = await activeRuntime.startProject();
      if (!result.success) return { ok: false, statusCode: 409, error: result.error.message, body: operatorApiContracts['runtime.startProject'].error.parse({ success: false, command: result.command, actionable_error: result.error }), outcomeSummary: result.error.message };
      return { ok: true, body: { success: true, command: result.command, intent: result.intent, run: result.run }, outcomeSummary: 'start_project accepted' };
    } }) as never,
    'runtime.stopProject': ({ request, reply }) => runMutatingRoute({ request, reply, projectRoot, action: 'runtime.stop_project', safety_class: 'low', target_kind: 'runtime', target_id: 'project', mutate: async () => {
      const activeRuntime = getActiveRuntime();
      if (!activeRuntime) { const body = runtimeUnavailableError('stop_project'); return { ok: false, statusCode: 503, error: body.actionable_error.message as string, body: operatorApiContracts['runtime.stopProject'].error.parse(body), outcomeSummary: 'active runtime unavailable' }; }
      const result = await activeRuntime.stopProject();
      return { ok: true, body: { success: true, command: result.command, intent: result.intent, ...(result.run ? { run: result.run } : {}) }, outcomeSummary: 'stop_project accepted' };
    } }) as never,
    'runtime.pause': ({ request, reply }) => runMutatingRoute({ request, reply, projectRoot, action: 'runtime.pause', safety_class: 'low', target_kind: 'runtime', target_id: 'project', mutate: async () => {
      const result = pauseRuntimeControl({ projectRoot, activeRuntime: getActiveRuntime() });
      if (!result.ok) { const error = result.message?.includes('RuntimeState layout conflict') ? 'RuntimeStateLayoutError' : result.error ?? 'Failed to pause runtime'; return { ok: false, statusCode: result.statusCode ?? 500, error: result.message ?? error, body: { error, message: result.message } }; }
      return { ok: true, body: result.state ?? readRuntimeState(projectRoot) };
    } }) as never,
    'runtime.resume': ({ request, reply }) => runMutatingRoute({ request, reply, projectRoot, action: 'runtime.resume', safety_class: 'low', target_kind: 'runtime', target_id: 'project', mutate: async () => {
      const result = resumeRuntimeControl({ projectRoot, activeRuntime: getActiveRuntime() });
      if (!result.ok) { const error = result.message?.includes('RuntimeState layout conflict') ? 'RuntimeStateLayoutError' : result.error ?? 'Failed to resume runtime'; return { ok: false, statusCode: result.statusCode ?? 500, error: result.message ?? error, body: { error, message: result.message, ...(result.action ? { action: result.action } : {}) } }; }
      return { ok: true, body: result.state ?? readRuntimeState(projectRoot) };
    } }) as never,
    'cards.list': () => { const cards = store.list().map(withOperatorAllowedActions); return { body: { cards, total: cards.length } }; },
    'cards.get': ({ params }) => { const id = (params as unknown as { id: string }).id; const card = store.read(id); if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } }; return { body: { card: withOperatorAllowedActions(card), children: store.listChildren(id).map((childId) => store.read(childId)).filter((c): c is CardRecord => c !== null).map(withOperatorAllowedActions), ancestorIds: store.getAncestors(id) } }; },

    'cards.history.list': ({ params }) => {
      const id = (params as unknown as { id: string }).id;
      const card = store.read(id);
      if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
      const history = store.listCardHistory(id).map((entry) => redactValue(historyHeader(entry)));
      return { body: { history, total: history.length } };
    },
    'cards.history.get': ({ params }) => {
      const { id, seq: seqRaw } = params as unknown as { id: string; seq: string };
      const card = store.read(id);
      if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
      const seq = Number.parseInt(seqRaw, 10);
      if (!Number.isInteger(seq) || seq <= 0) return { statusCode: 400, body: { error: 'Invalid version sequence', version_seq: seqRaw } };
      const entry = store.listCardHistory(id).find((candidate) => candidate.version_seq === seq);
      if (!entry) return { statusCode: 404, body: { error: 'Card history entry not found', cardId: id, version_seq: seq } };
      return { body: { entry: redactValue(entry) } };
    },
    'cards.diff': ({ params, query }) => {
      const id = (params as unknown as { id: string }).id;
      const { from: fromRaw, to: toRaw } = query as unknown as { from: string; to: string };
      const card = store.read(id);
      if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
      const from = Number.parseInt(fromRaw, 10);
      const to = Number.parseInt(toRaw, 10);
      if (!Number.isInteger(from) || from <= 0 || !Number.isInteger(to) || to <= 0) return { statusCode: 400, body: { error: 'from and to query parameters are required positive integers' } };
      try { return { body: { diff: redactValue(store.diffCard(id, from, to)), from, to, card_id: id } }; }
      catch (err) { const message = err instanceof Error ? err.message : String(err); return { statusCode: message.includes('not found') || message.includes('has no version') ? 404 : 500, body: { error: message.includes('not found') || message.includes('has no version') ? 'Card diff source not found' : 'Failed to diff card', message } }; }
    },
    'cards.delete': ({ request, reply, params }) => runMutatingRoute({ request, reply, projectRoot, action: 'card.delete', safety_class: 'destructive', target_kind: 'card', target_id: (params as unknown as { id: string }).id, mutate: async () => {
      const id = (params as unknown as { id: string }).id;
      try { store.delete(id); return { ok: true, statusCode: 204, body: undefined, outcomeSummary: 'card deleted' }; }
      catch (err) { const message = err instanceof Error ? err.message : String(err); if (message.includes('not found')) return { ok: false, statusCode: 404, error: message, body: { error: 'Card not found' }, outcomeSummary: message }; return { ok: false, statusCode: 400, error: message, body: { error: 'Card deletion failed', message }, outcomeSummary: message }; }
    } }) as never,
    'cards.create': ({ request, reply, body }) => runMutatingRoute({ request, reply, projectRoot, action: 'card.create', safety_class: 'low', target_kind: 'card', target_id: null, mutate: async () => {
      try { const data = (body ?? {}) as Record<string, unknown>; const card = store.create({ ...inputDefaults(), type: (data.type as CardType) || inputDefaults().type, parent: (data.parent as string | null) ?? inputDefaults().parent, title: (data.title as string) || inputDefaults().title, description: (data.description as string) || inputDefaults().description, status: (data.status as CardStatus) || inputDefaults().status, tags: (data.tags as string[]) ?? inputDefaults().tags, priority: (data.priority as number) ?? inputDefaults().priority, urgency: (data.urgency as CardRecord['urgency']) || inputDefaults().urgency, created_by: (data.created_by as CardRecord['created_by']) || inputDefaults().created_by, depends_on: (data.depends_on as string[]) ?? inputDefaults().depends_on, related: (data.related as string[]) ?? inputDefaults().related, acceptance: (data.acceptance as string) || inputDefaults().acceptance, result: (data.result as Record<string, unknown>) ?? inputDefaults().result, metrics: (data.metrics as Record<string, string | number | boolean | null>) ?? inputDefaults().metrics, estimate: (data.estimate as string) ?? inputDefaults().estimate, error: (data.error as string) ?? inputDefaults().error, retries: (data.retries as number) ?? inputDefaults().retries, subtype: (data.subtype as string) ?? inputDefaults().subtype, assigned_to: (data.assigned_to as string) ?? inputDefaults().assigned_to, instructions_file: (data.instructions_file as string) ?? inputDefaults().instructions_file }); return { ok: true, statusCode: 201, body: { card: withOperatorAllowedActions(card) }, outcomeSummary: 'card created' }; }
      catch (err) { const message = err instanceof Error ? err.message : String(err); return { ok: false, statusCode: 400, error: message, body: { error: 'Card creation failed', message }, outcomeSummary: message }; }
    } }) as never,
    'cards.update': ({ request, reply, params, body }) => runMutatingRoute({ request, reply, projectRoot, action: 'card.update', safety_class: 'low', target_kind: 'card', target_id: (params as unknown as { id: string }).id, mutate: async () => {
      const id = (params as unknown as { id: string }).id; const data = (body ?? {}) as Record<string, unknown>; const allowedFields = new Set(['title','description','status','tags','priority','urgency','acceptance','result','metrics','depends_on','related','estimate','error','retries','parent','assigned_to','type','subtype','instructions_file']); const changes: Record<string, unknown> = {}; for (const [key, value] of Object.entries(data)) if (allowedFields.has(key)) changes[key] = value; const tracked = Object.keys(changes).some((field) => TRACKED_UPDATE_FIELDS.has(field));
      try { if (Object.keys(changes).length === 0) return { ok: false, statusCode: 400, error: 'No valid fields to update', body: { error: 'No valid fields to update' }, outcomeSummary: 'no valid fields to update' }; const card = tracked ? store.mutateCard(id, changes as Partial<CardRecord>, { actor: 'user', surface: 'rest', reason: 'REST card update' }) : store.update(id, changes as Partial<CardRecord>); return { ok: true, body: { card: withOperatorAllowedActions(card) }, outcomeSummary: 'card updated' }; }
      catch (err) { const message = err instanceof Error ? err.message : String(err); if (message.includes('not found')) return { ok: false, statusCode: 404, error: message, body: { error: 'Card not found' }, outcomeSummary: message }; return { ok: false, statusCode: 400, error: message, body: { error: 'Card update failed', message }, outcomeSummary: message }; }
    } }) as never,
  };

  runtime.mount(fastify, operatorApiContracts, handlers);
}
