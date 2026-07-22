import { argKeys, asRecord, cardPart, describeJsonlTail, formatBytes, oneLine, pathParts, str, textPart, webfetchStashPart } from './helpers';
import type { ResultPresenterContext, ToolPresenter } from './types';

function cardResult(ctx: ResultPresenterContext, verb: string) {
  const record = ctx.dataRecord;
  const nested = asRecord(record?.card);
  const card = nested ?? record;
  const id = str(card?.id ?? record?.card_id);
  return { headline: id ? [{ kind: 'text' as const, text: `${verb} ` }, ...cardPart(id)] : textPart(verb) };
}

function processResult(ctx: ResultPresenterContext) {
  const r = ctx.dataRecord;
  const exit = typeof r?.exit_code === 'number' ? r.exit_code : null;
  const status = typeof r?.status === 'string' ? r.status : null;
  const procId = typeof r?.process_id === 'string' ? r.process_id : null;
  const parts: string[] = [];
  if (exit !== null) parts.push(`exit ${exit}`);
  if (status) parts.push(status);
  return { headline: textPart(parts.length ? parts.join(' · ') : 'completed'), detail: procId ? textPart(`process ${procId}`) : undefined };
}

function arrayCount(ctx: ResultPresenterContext, noun: string) {
  const list = Array.isArray(ctx.data) ? ctx.data : null;
  return { headline: list ? textPart(`${list.length} ${noun}${list.length === 1 ? '' : 's'}`) : textPart(`${noun} list loaded`) };
}

export const TOOL_PRESENTERS = {
  activate_card: { action: 'Activate', call: (a) => ({ icon: '▶', headline: cardPart(a.card_id) }), result: (ctx) => ({ headline: textPart(str(ctx.dataRecord?.outcome) || 'activated'), detail: cardPart(ctx.dataRecord?.card_id) }) },
  apply_patch: { action: 'Patch', call: () => ({ icon: '🩹', headline: textPart('apply patch') }), result: (ctx) => { const n = Array.isArray(ctx.dataRecord?.changed_files) ? ctx.dataRecord.changed_files.length : null; return { headline: textPart(n === null ? 'patch applied' : `patched ${n} file${n === 1 ? '' : 's'}`) }; } },
  cancel_card: { action: 'Cancel', call: (a) => ({ icon: '⏹', headline: cardPart(Object.hasOwn(a, 'card_id') ? a.card_id : a.cardId) }), result: (ctx) => ({ headline: textPart('cancelled'), detail: cardPart(ctx.dataRecord?.card_id) }) },
  create_card: { action: 'Create', call: (a) => ({ icon: '➕', headline: textPart(oneLine(a.title, 64) || `${str(a.type)} card`), detail: [...textPart(a.type), ...cardPart(a.parent)] }), result: (ctx) => cardResult(ctx, 'created') },
  delete_card: { action: 'Delete', call: (a) => ({ icon: '🗑', headline: textPart(Array.isArray(a.ids) ? a.ids.join(', ') : '') }), result: (ctx) => ({ headline: textPart(`deleted ${Array.isArray(ctx.dataRecord?.deleted) ? ctx.dataRecord.deleted.length : 0} card${Array.isArray(ctx.dataRecord?.deleted) && ctx.dataRecord.deleted.length === 1 ? '' : 's'}`) }) },
  diff_card: { action: 'Diff', group: 'context', call: (a) => ({ icon: '🔀', headline: cardPart(a.cardId) }) },
  edit: { action: 'Edit', call: (a) => ({ icon: '✎', headline: pathParts(a.path), detail: textPart('replace text') }), result: (ctx) => ({ headline: textPart(`edited ${str(ctx.dataRecord?.path) || 'file'}`) }) },
  edit_card: { action: 'Edit card', call: (a) => { const keys = Object.keys(a).filter((key) => key !== 'card_id'); return { icon: '✎', headline: cardPart(a.card_id), detail: keys.length ? textPart(`change ${keys.join(', ')}`) : undefined }; }, result: (ctx) => cardResult(ctx, 'edited') },
  emit_result: { action: 'Complete', call: (a) => ({ icon: '✅', headline: textPart(a.summary, 96), detail: textPart(a.outcome) }), result: () => ({ headline: textPart('result accepted') }) },
  get_card: { action: 'Inspect', group: 'context', call: (a) => ({ icon: '🔎', headline: cardPart(a.id) }), result: (ctx) => { const data = ctx.dataRecord; const card = asRecord(data?.card) ?? data; const status = str(data?.status) || str(asRecord(card?.lifecycle)?.status); return { headline: textPart(str(card?.title) || `card ${str(card?.id)}`), detail: textPart([str(card?.type), status].filter(Boolean).join(' · ')) }; } },
  get_card_history_entry: { action: 'History', group: 'context', call: (a) => ({ icon: '🕘', headline: cardPart(a.cardId), detail: textPart(`v${str(a.version_seq)}`) }) },
  get_status: { action: 'Status', group: 'context', call: () => ({ icon: '📊', headline: textPart('project status') }) },
  get_tree: { action: 'Tree', group: 'context', call: (a) => ({ icon: '🌳', headline: textPart(a.rootId ? `subtree ${str(a.rootId)}` : 'project tree') }), result: () => ({ headline: textPart('tree fetched') }) },
  glob: { action: 'Glob', group: 'context', call: (a) => ({ icon: '📂', headline: pathParts(a.directory), detail: textPart(a.pattern) }), result: (ctx) => { const n = Array.isArray(ctx.dataRecord?.matches) ? ctx.dataRecord.matches.length : null; return { headline: n === null ? textPart('glob completed') : textPart(`${n} match${n === 1 ? '' : 'es'}`) }; } },
  grep: { action: 'Grep', group: 'context', call: (a) => ({ icon: '🔎', headline: textPart(a.pattern, 80), detail: a.path === undefined ? undefined : pathParts(a.path) }), result: (ctx) => { const n = Array.isArray(ctx.dataRecord?.matches) ? ctx.dataRecord.matches.length : null; return { headline: n === null ? textPart('grep completed') : textPart(`${n} match${n === 1 ? '' : 'es'}`) }; } },
  kill_process: { action: 'Kill', call: (a) => ({ icon: '🛑', headline: textPart(`process ${str(a.process_id)}`) }), result: processResult },
  list_agent_sessions: { action: 'List sessions', group: 'context', call: () => ({ icon: '👥', headline: textPart('agent sessions') }), result: (ctx) => arrayCount(ctx, 'session') },
  list_card_history: { action: 'History', group: 'context', call: (a) => ({ icon: '🕘', headline: cardPart(a.cardId) }), result: (ctx) => arrayCount(ctx, 'version') },
  list_cards: { action: 'List cards', group: 'context', call: (a) => ({ icon: '🔎', headline: textPart(Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : str(v)}`).join(' · ') || 'all cards') }), result: (ctx) => arrayCount(ctx, 'card') },
  list_processes_tool: { action: 'List processes', call: (a) => ({ icon: '⚙', headline: textPart(Object.keys(a).length ? `filter ${argKeys(a)}` : 'all processes') }), result: (ctx) => arrayCount(ctx, 'process') },
  mcp_reconcile: { action: 'Reconcile MCP', call: () => ({ icon: '🔌', headline: textPart('retry MCP convergence from persisted configuration') }) },
  mcp_tool_call: { action: 'MCP', call: (a) => ({ icon: '🔌', headline: textPart(`${str(a.serverName)}/${str(a.toolName)}`), detail: a.args === undefined ? undefined : textPart(a.args, 72) }), result: (ctx) => ({ headline: typeof ctx.data === 'string' || typeof ctx.data === 'number' || typeof ctx.data === 'boolean' ? textPart(ctx.data, 96) : textPart('MCP call completed') }) },
  navigate_back: { action: 'Back', call: () => ({ icon: '↩', headline: textPart('navigate back') }), result: () => ({ headline: textPart('back navigation queued') }) },
  navigate_workspace: { action: 'Navigate', call: (a) => { const target = asRecord(a.target); return { icon: '🧭', headline: textPart([str(target?.kind), str(target?.id), str(target?.refinement)].filter(Boolean).join(' · ')) }; }, result: () => ({ headline: textPart('workspace navigation queued') }) },
  pause_runtime: { action: 'Pause', call: () => ({ icon: '⏸', headline: textPart('pause runtime') }) },
  queue_notification: { action: 'Notify', call: (a) => ({ icon: '🔔', headline: cardPart(a.card_id), detail: textPart(`${str(a.kind)} · ${oneLine(a.body, 96)}`) }), result: () => ({ headline: textPart('notification queued') }) },
  read: { action: 'Read', group: 'context', call: (a) => ({ icon: '📖', headline: pathParts(a.path) }), result: (ctx) => { const r = ctx.dataRecord; const entries = Array.isArray(r?.entries) ? r.entries.length : null; if (entries !== null) return { headline: textPart(`${entries} entr${entries === 1 ? 'y' : 'ies'}`) }; const content = typeof r?.content === 'string' ? r.content : ''; const lines = typeof r?.total_lines === 'number' ? r.total_lines : content ? content.split('\n').length : 0; return { headline: textPart(lines ? `${lines} lines` : 'read completed') }; } },
  read_agent_session: { action: 'Session', group: 'context', call: (a) => ({ icon: '🧵', headline: textPart(`session ${str(a.sessionId)}`) }), result: (ctx) => { const n = Array.isArray(ctx.dataRecord?.messages) ? ctx.dataRecord.messages.length : null; return { headline: n === null ? textPart('session loaded') : textPart(`${n} message${n === 1 ? '' : 's'}`) }; } },
  read_control_actions: { action: 'Audit', group: 'context', call: (a) => ({ icon: '🧭', headline: textPart(`control actions × ${str(a.limit ?? 50)}${a.since ? ` since ${str(a.since)}` : ''}`) }), result: (ctx) => describeJsonlTail(ctx, 'actions', 'control actions') },
  read_runtime_errors: { action: 'Errors', group: 'context', call: (a) => ({ icon: '🩺', headline: textPart(`newest errors × ${str(a.limit ?? 50)}`) }), result: (ctx) => describeJsonlTail(ctx, 'errors', 'errors') },
  read_runtime_events: { action: 'Events', group: 'context', call: (a) => ({ icon: '📜', headline: textPart(`newest events × ${str(a.limit ?? 50)}${a.kind ? ` [${str(a.kind)}]` : ''}`) }), result: (ctx) => describeJsonlTail(ctx, 'events', 'events') },
  reconfigure: { action: 'Reconfigure', call: (a) => ({ icon: '⚙', headline: textPart(str(a.action)) }), result: () => ({ headline: textPart('configuration updated') }) },
  reorder_child: { action: 'Reorder', call: (a) => ({ icon: '↕', headline: textPart((Array.isArray(a.orderedChildIds) ? a.orderedChildIds : []).join(' → ')), detail: Object.hasOwn(a, 'parentId') ? cardPart(a.parentId) : undefined }), result: () => ({ headline: textPart('cards reordered') }) },
  restart_server: { action: 'Restart server', call: () => ({ icon: '↻', headline: textPart('restart server') }), result: () => ({ headline: textPart('server restart requested') }) },
  resume_runtime: { action: 'Resume', call: () => ({ icon: '▶', headline: textPart('resume runtime') }) },
  run_command: { action: 'Shell', call: (a) => ({ icon: '⚡', headline: textPart(a.command, 80) }), result: processResult },
  show_config: { action: 'Show config', call: () => ({ icon: '⚙', headline: textPart('configuration') }), result: () => ({ headline: textPart('configuration loaded') }) },
  skill: { action: 'Skill', group: 'context', call: (a) => ({ icon: '🪄', headline: textPart(a.name ?? 'list skills') }), result: (ctx) => { const data = ctx.dataRecord; if (Array.isArray(data?.skills)) { const n = data.skills.length; return { headline: textPart(`${n} skill${n === 1 ? '' : 's'}`) }; } if (typeof data?.skill_name === 'string' && typeof data.skill_content === 'string') return { headline: textPart('skill loaded') }; return { headline: textPart('skills loaded') }; } },
  start_project: { action: 'Start project', call: () => ({ icon: '▶', headline: textPart('start project') }), result: () => ({ headline: textPart('project start requested') }) },
  stop_project: { action: 'Stop project', call: () => ({ icon: '■', headline: textPart('stop project') }), result: () => ({ headline: textPart('project stopped') }) },
  wait_process: { action: 'Wait', call: (a) => ({ icon: '⏳', headline: textPart(`process ${str(a.process_id)}`) }), result: processResult },
  webfetch: { action: 'Fetch', group: 'web', call: (a) => ({ icon: '🌐', headline: textPart(a.url, 80) }), result: (ctx) => { const stash = webfetchStashPart(ctx.dataRecord?.stash_url); if (stash) return { headline: [stash] }; return { headline: textPart(str(ctx.dataRecord?.saved_as ?? ctx.dataRecord?.url) || 'fetched', 96) }; } },
  websearch: { action: 'Search', group: 'web', call: (a) => ({ icon: '🌐', headline: textPart(a.query, 80) }), result: (ctx) => { const n = Array.isArray(ctx.dataRecord?.results) ? ctx.dataRecord.results.length : null; return { headline: n === null ? textPart('search completed') : textPart(`${n} result${n === 1 ? '' : 's'}`) }; } },
  write: { action: 'Write', call: (a) => ({ icon: '✏️', headline: pathParts(a.path), detail: textPart(`${str(a.content).length} chars`) }), result: (ctx) => ({ headline: textPart(typeof ctx.dataRecord?.bytes === 'number' ? `wrote ${formatBytes(ctx.dataRecord.bytes)}` : 'wrote file') }) },
} as const satisfies Readonly<Record<string, ToolPresenter>>;

export type BuiltInToolName = keyof typeof TOOL_PRESENTERS;

export function getToolPresenter(name: string): ToolPresenter | undefined {
  return Object.hasOwn(TOOL_PRESENTERS, name) ? TOOL_PRESENTERS[name as BuiltInToolName] : undefined;
}
