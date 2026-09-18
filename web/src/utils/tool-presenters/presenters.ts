import { argKeys, asRecord, cardPart, describeJsonlTail, formatBytes, oneLine, pathParts, processLogPart, str, textPart, webfetchContentPart } from './helpers';
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
  const stdoutLink = processLogPart(r?.stdout_url, 'stdout');
  const stderrLink = processLogPart(r?.stderr_url, 'stderr');
  const detail = [
    ...textPart(`${procId ? `process ${procId} · ` : ''}stdout ${r?.stdout_complete === true ? 'complete' : 'partial'}`),
    ...(stdoutLink ? [...textPart(' · '), stdoutLink] : []),
    ...textPart(` · stderr ${r?.stderr_complete === true ? 'complete' : 'partial'}`),
    ...(stderrLink ? [...textPart(' · '), stderrLink] : []),
  ];
  return { headline: textPart(parts.length ? parts.join(' · ') : 'completed'), detail };
}

function pageCount(page: unknown, noun: string, plural?: string, totalQualifier = '') {
  const record = asRecord(page);
  const returned = typeof record?.returned === 'number' ? record.returned : Array.isArray(record?.items) ? record.items.length : null;
  const total = typeof record?.total === 'number' ? record.total : null;
  if (returned === null) return { headline: textPart(`${noun} list loaded`) };
  const pluralNoun = plural ?? `${noun}s`;
  const items = Array.isArray(record?.items) ? record.items : [];
  const containsSlice = items.some((item) => {
    const value = asRecord(item);
    return typeof value?.content_hex === 'string' && typeof value.total_bytes === 'number';
  });
  if (containsSlice) {
    const slices = `${returned} partial ${noun} slice${returned === 1 ? '' : 's'}`;
    return { headline: textPart(total === null ? slices : `${slices} of ${total}${totalQualifier} ${total === 1 ? noun : pluralNoun}`) };
  }
  if (total === null) return { headline: textPart(`${returned} ${returned === 1 ? noun : pluralNoun}`) };
  return { headline: textPart(`${returned} of ${total}${totalQualifier} ${total === 1 ? noun : pluralNoun}`) };
}

function pageWithFullCount(ctx: ResultPresenterContext, key: string, noun: string, fullTotalKey: string, fullLabel: string, totalQualifier = '') {
  const page = pageCount(ctx.dataRecord?.[key], noun, undefined, totalQualifier);
  const fullTotal = ctx.dataRecord?.[fullTotalKey];
  return {
    ...page,
    detail: typeof fullTotal === 'number' ? textPart(`${fullTotal} ${fullLabel}`) : undefined,
  };
}

function webfetchResult(ctx: ResultPresenterContext) {
  const result = ctx.dataRecord;
  if (typeof result?.saved_as === 'string') return { headline: textPart(result.saved_as, 96) };
  if (result?.kind !== 'text') return { headline: textPart(str(result?.redacted_url) || 'fetched', 96) };
  const content = webfetchContentPart(result.content_url);
  const headline = result.head_complete === false && content
    ? [content]
    : textPart(str(result.redacted_url) || 'fetched', 96);
  const head = oneLine(result.head, 72);
  const headBytes = typeof result.head_utf8_bytes === 'number' ? result.head_utf8_bytes : 0;
  const totalBytes = typeof result.redacted_text_utf8_bytes === 'number' ? result.redacted_text_utf8_bytes : 0;
  const completeness = result.head_complete === true ? 'head complete' : 'head incomplete';
  const fetchState = result.fetch_truncated === true ? 'fetch truncated' : 'fetch complete';
  return {
    headline,
    detail: textPart(`${head ? `head: ${head} · ` : 'empty head · '}${formatBytes(headBytes)} of ${formatBytes(totalBytes)} · ${completeness} · ${fetchState}`),
  };
}

function mcpResult(ctx: ResultPresenterContext) {
  const result = ctx.dataRecord;
  const headline = textPart('MCP call completed');
  if (typeof result?.result_complete !== 'boolean' || typeof result.result_utf8_bytes !== 'number') return { headline };
  return {
    headline,
    detail: textPart(`result ${result.result_complete ? 'complete' : 'truncated'} · ${formatBytes(result.result_utf8_bytes)} total JSON source`),
  };
}

export const TOOL_PRESENTERS = {
  activate_card: { action: 'Activate', call: (a) => ({ icon: '▶', headline: cardPart(a.card_id) }), result: (ctx) => ({ headline: textPart(str(ctx.dataRecord?.outcome) || 'activated'), detail: cardPart(ctx.dataRecord?.card_id) }) },
  apply_patch: { action: 'Patch', call: () => ({ icon: '🩹', headline: textPart('apply patch') }), result: (ctx) => { const n = Array.isArray(ctx.dataRecord?.changed_files) ? ctx.dataRecord.changed_files.length : null; return { headline: textPart(n === null ? 'patch applied' : `patched ${n} file${n === 1 ? '' : 's'}`) }; } },
  cancel_card: { action: 'Cancel', call: (a) => ({ icon: '⏹', headline: cardPart(Object.hasOwn(a, 'card_id') ? a.card_id : a.cardId) }), result: (ctx) => ({ headline: textPart('cancelled'), detail: cardPart(ctx.dataRecord?.card_id) }) },
  create_card: { action: 'Create', call: (a) => ({ icon: '➕', headline: textPart(oneLine(a.title, 64) || `${str(a.type)} card`), detail: [...textPart(a.type), ...cardPart(a.parent)] }), result: (ctx) => cardResult(ctx, 'created') },
  delete_card: { action: 'Delete', call: (a) => ({ icon: '🗑', headline: textPart(Array.isArray(a.ids) ? a.ids.join(', ') : '') }), result: (ctx) => ({ headline: textPart(`deleted ${Array.isArray(ctx.dataRecord?.deleted) ? ctx.dataRecord.deleted.length : 0} card${Array.isArray(ctx.dataRecord?.deleted) && ctx.dataRecord.deleted.length === 1 ? '' : 's'}`) }) },
  diff_card_versions: { action: 'Diff', group: 'context', call: (a) => ({ icon: '🔀', headline: cardPart(a.card_id), detail: textPart(`v${str(a.from_version)} → v${str(a.to_version)}`) }) },
  edit: { action: 'Edit', call: (a) => ({ icon: '✎', headline: pathParts(a.path), detail: textPart('replace text') }), result: (ctx) => ({ headline: textPart(`edited ${str(ctx.dataRecord?.path) || 'file'}`) }) },
  edit_card: { action: 'Edit card', call: (a) => { const keys = Object.keys(a).filter((key) => key !== 'card_id'); return { icon: '✎', headline: cardPart(a.card_id), detail: keys.length ? textPart(`change ${keys.join(', ')}`) : undefined }; }, result: (ctx) => cardResult(ctx, 'edited') },
  emit_result: { action: 'Complete', call: (a) => ({ icon: '✅', headline: textPart(a.summary, 96), detail: textPart(a.outcome) }), result: () => ({ headline: textPart('result accepted') }) },
  get_card: { action: 'Inspect', group: 'context', call: (a) => ({ icon: '🔎', headline: cardPart(a.id), detail: textPart(str(a.section)) }), result: (ctx) => { const data = ctx.dataRecord; const card = asRecord(data?.card); const content = asRecord(data?.content); const summary = card ?? asRecord(content?.card); if (summary) { const status = str(summary.status) || str(asRecord(summary.lifecycle)?.status); return { headline: textPart(str(summary.title) || `card ${str(summary.id)}`), detail: textPart([str(summary.type), status].filter(Boolean).join(' · ')) }; } return { headline: textPart(data?.section ? `section ${str(data.section)}` : 'card loaded') }; } },
  get_card_version: { action: 'Version', group: 'context', call: (a) => ({ icon: '🕘', headline: cardPart(a.card_id), detail: textPart(`v${str(a.version)} · ${str(a.section)}`) }) },
  get_status: { action: 'Status', group: 'context', call: () => ({ icon: '📊', headline: textPart('project status') }) },
  get_tree: { action: 'Tree', group: 'context', call: (a) => ({ icon: '🌳', headline: textPart(`subtree ${str(a.rootId)}`), detail: textPart(`depth ${str(a.depth ?? 3)}`) }), result: () => ({ headline: textPart('tree fetched') }) },
  glob: { action: 'Glob', group: 'context', call: (a) => ({ icon: '📂', headline: pathParts(a.directory), detail: textPart(a.pattern) }), result: () => ({ headline: textPart('glob completed') }) },
  grep: { action: 'Grep', group: 'context', call: (a) => ({ icon: '🔎', headline: textPart(a.pattern, 80), detail: a.path === undefined ? undefined : pathParts(a.path) }), result: () => ({ headline: textPart('grep completed') }) },
  kill_process: { action: 'Kill', call: (a) => ({ icon: '🛑', headline: textPart(`process ${str(a.process_id)}`) }), result: processResult },
  list_agent_sessions: { action: 'List sessions', group: 'context', call: () => ({ icon: '👥', headline: textPart('agent sessions') }), result: (ctx) => pageCount(ctx.dataRecord?.sessions, 'session') },
  list_card_versions: { action: 'Versions', group: 'context', call: (a) => ({ icon: '🕘', headline: cardPart(a.card_id) }), result: (ctx) => pageCount(ctx.dataRecord?.versions, 'version') },
  list_cards: { action: 'List cards', group: 'context', call: (a) => ({ icon: '🔎', headline: textPart(Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : str(v)}`).join(' · ') || 'all cards') }), result: (ctx) => pageCount(ctx.dataRecord?.cards, 'card') },
  list_processes_tool: { action: 'List processes', call: (a) => ({ icon: '⚙', headline: textPart(Object.keys(a).length ? `filter ${argKeys(a)}` : 'all processes') }), result: (ctx) => pageCount(ctx.dataRecord?.processes, 'process', 'processes') },
  mcp_reconcile: { action: 'Reconcile MCP', call: () => ({ icon: '🔌', headline: textPart('retry MCP convergence from persisted configuration') }) },
  mcp_tool_call: { action: 'MCP', call: (a) => ({ icon: '🔌', headline: textPart(`${str(a.serverName)}/${str(a.toolName)}`), detail: a.args === undefined ? undefined : textPart(a.args, 72) }), result: mcpResult },
  navigate_back: { action: 'Back', call: () => ({ icon: '↩', headline: textPart('navigate back') }), result: () => ({ headline: textPart('back navigation queued') }) },
  navigate_workspace: { action: 'Navigate', call: (a) => { const target = asRecord(a.target); return { icon: '🧭', headline: textPart([str(target?.kind), str(target?.id), str(target?.refinement)].filter(Boolean).join(' · ')) }; }, result: () => ({ headline: textPart('workspace navigation queued') }) },
  pause_runtime: { action: 'Pause', call: () => ({ icon: '⏸', headline: textPart('pause runtime') }) },
  queue_notification: { action: 'Notify', call: (a) => ({ icon: '🔔', headline: cardPart(a.card_id), detail: textPart(`${str(a.kind)} · ${oneLine(a.body, 96)}`) }), result: () => ({ headline: textPart('notification queued') }) },
  read: { action: 'Read', group: 'context', call: (a) => ({ icon: '📖', headline: pathParts(a.path) }), result: (ctx) => { const r = ctx.dataRecord; const entries = asRecord(r?.entries); if (entries) return pageCount(entries, 'entry', 'entries'); const totalBytes = typeof r?.total_bytes === 'number' ? r.total_bytes : null; return { headline: textPart(totalBytes !== null && totalBytes > 0 ? formatBytes(totalBytes) : 'read completed') }; } },
  read_agent_session: { action: 'Session', group: 'context', call: (a) => ({ icon: '🧵', headline: textPart(`session ${str(a.session_id)}`), detail: textPart(str(a.section) || 'messages') }), result: (ctx) => ctx.dataRecord?.section === 'context'
    ? pageWithFullCount(ctx, 'context', 'context item', 'total_visible_entries', 'total visible messages')
    : pageWithFullCount(ctx, 'messages', 'message', 'total_visible_entries', 'total visible messages', ' selected') },
  read_control_actions: { action: 'Audit', group: 'context', call: (a) => ({ icon: '🧭', headline: textPart(`control actions × ${str(a.limit ?? 50)}${a.since ? ` since ${str(a.since)}` : ''}`) }), result: (ctx) => describeJsonlTail(ctx, 'actions', 'control actions') },
  read_record_version: { action: 'Record version', group: 'context', call: (a) => ({ icon: '🕘', headline: cardPart(a.card_id), detail: textPart(`${str(a.record_name)} v${str(a.version)}`) }) },
  read_runtime_errors: { action: 'Errors', group: 'context', call: (a) => ({ icon: '🩺', headline: textPart(`newest errors × ${str(a.limit ?? 50)}`) }), result: (ctx) => pageWithFullCount(ctx, 'errors', 'error', 'total_lines', 'total error lines', ' selected') },
  read_runtime_events: { action: 'Events', group: 'context', call: (a) => ({ icon: '📜', headline: textPart(`newest events × ${str(a.limit ?? 50)}${a.kind ? ` [${str(a.kind)}]` : ''}`) }), result: (ctx) => pageWithFullCount(ctx, 'events', 'event', 'total_lines', 'total event lines', ' selected') },
  reconfigure: { action: 'Reconfigure', call: (a) => ({ icon: '⚙', headline: textPart(str(a.action)) }), result: () => ({ headline: textPart('configuration updated') }) },
  reorder_child: { action: 'Reorder', call: (a) => ({ icon: '↕', headline: textPart((Array.isArray(a.orderedChildIds) ? a.orderedChildIds : []).join(' → ')), detail: Object.hasOwn(a, 'parentId') ? cardPart(a.parentId) : undefined }), result: () => ({ headline: textPart('cards reordered') }) },
  reopen_card: { action: 'Reopen', call: (a) => ({ icon: '↻', headline: cardPart(Object.hasOwn(a, 'card_id') ? a.card_id : a.cardId) }), result: (ctx) => ({ ...cardResult(ctx, 'reopened'), detail: textPart(str(ctx.dataRecord?.status) || 'changed') }) },
  restart_server: { action: 'Restart server', call: () => ({ icon: '↻', headline: textPart('restart server') }), result: () => ({ headline: textPart('server restart requested') }) },
  resume_runtime: { action: 'Resume', call: () => ({ icon: '▶', headline: textPart('resume runtime') }) },
  run_command: { action: 'Shell', call: (a) => ({ icon: '⚡', headline: textPart(a.command, 80) }), result: processResult },
  show_config: { action: 'Show config', call: () => ({ icon: '⚙', headline: textPart('configuration') }), result: () => ({ headline: textPart('configuration loaded') }) },
  skill: { action: 'Skill', group: 'context', call: (a) => ({ icon: '🪄', headline: textPart(a.name ?? 'list skills') }), result: (ctx) => { const data = ctx.dataRecord; if (Array.isArray(data?.skills)) { const n = data.skills.length; return { headline: textPart(`${n} skill${n === 1 ? '' : 's'}`) }; } if (typeof data?.skill_name === 'string' && typeof data.skill_content === 'string') return { headline: textPart('skill loaded') }; return { headline: textPart('skills loaded') }; } },
  start_project: { action: 'Start project', call: () => ({ icon: '▶', headline: textPart('start project') }), result: () => ({ headline: textPart('project start requested') }) },
  stop_project: { action: 'Stop project', call: () => ({ icon: '■', headline: textPart('stop project') }), result: () => ({ headline: textPart('project stopped') }) },
  wait_process: { action: 'Wait', call: (a) => ({ icon: '⏳', headline: textPart(`process ${str(a.process_id)}`) }), result: processResult },
  webfetch: { action: 'Fetch', group: 'web', call: (a) => ({ icon: '🌐', headline: textPart(a.url, 80) }), result: webfetchResult },
  websearch: { action: 'Search', group: 'web', call: (a) => ({ icon: '🌐', headline: textPart(a.query, 80) }), result: (ctx) => { const n = Array.isArray(ctx.dataRecord?.results) ? ctx.dataRecord.results.length : null; return { headline: n === null ? textPart('search completed') : textPart(`${n} result${n === 1 ? '' : 's'}`) }; } },
  write: { action: 'Write', call: (a) => ({ icon: '✏️', headline: pathParts(a.path), detail: textPart(`${str(a.content).length} chars`) }), result: (ctx) => ({ headline: textPart(typeof ctx.dataRecord?.bytes === 'number' ? `wrote ${formatBytes(ctx.dataRecord.bytes)}` : 'wrote file') }) },
} as const satisfies Readonly<Record<string, ToolPresenter>>;

type BuiltInToolName = keyof typeof TOOL_PRESENTERS;

export function getToolPresenter(name: string): ToolPresenter | undefined {
  return Object.hasOwn(TOOL_PRESENTERS, name) ? TOOL_PRESENTERS[name as BuiltInToolName] : undefined;
}
