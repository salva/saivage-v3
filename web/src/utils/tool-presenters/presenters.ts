import { asRecord, cardPart, oneLine, pathLabel, pathParts, summaryPathParts, urlLabel, processLogPart, str, textPart, webfetchContentPart } from './helpers';
import type { InlinePart, ResultPresenterContext, ResultPresenterResult, SemanticSection, ToolPresenter } from './types';
import { ConversationSessionIdSchema } from '@saivage/schemas/conversation-session-id';

type Facts = Record<string, unknown>;
type Field = string | readonly [string, string];
const valueText = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const valueLanguage = (value: unknown): 'text' | 'json' => typeof value === 'string' ? 'text' : 'json';
export function valueParts(value: unknown, pretty = true): InlinePart[] {
  const text = pretty ? valueText(value) : typeof value === 'string' ? value : JSON.stringify(value);
  return textPart(text).map((part) => ({ ...part, language: valueLanguage(value) }));
}
function fields(title: string, facts: Facts | null, keys: readonly Field[]): SemanticSection {
  return { title, fields: keys.flatMap((key) => {
    const [name, label] = typeof key === 'string' ? [key, key.replaceAll('_', ' ')] : key;
    if (!facts || !Object.hasOwn(facts, name)) return [];
    const value = facts[name];
    const parts: InlinePart[] = ['session_id', 'id'].includes(name) && ConversationSessionIdSchema.safeParse(value).success
      ? [{ kind: 'session', id: value as string, label: value as string }]
      : ['card_id', 'parent_id', 'parent', 'id'].includes(name) && typeof value === 'string' && /^(project|card-[a-z]+(?:-[a-z]+){0,11})$/.test(value)
      ? cardPart(value, value) : ['path', 'target', 'current_url', 'accepted_version_url', 'version_url', 'record_url', 'saved_as'].includes(name) && typeof value === 'string'
        ? pathParts(value) : valueParts(value);
    return [{ label, parts }];
  }) };
}
function content(title: string, value: unknown, disclosure = false): SemanticSection[] {
  if (value === undefined) return [];
  const slice = asRecord(value);
  if (slice && typeof slice.content === 'string' && typeof slice.utf8_bytes === 'number' && typeof slice.offset_bytes === 'number' && typeof slice.next_offset_bytes === 'number') return [fields(`${title} — text slice coverage`, slice, ['utf8_bytes', 'offset_bytes', 'next_offset_bytes', 'total_bytes']), { title, content: slice.content, disclosure }];
  return [{ title, content: valueText(value), language: valueLanguage(value), disclosure }];
}
const cardFields = ['id', 'type', 'status', 'title', 'parent', 'depth', 'children_count', 'descendants', 'depth_omitted', 'head_id'] as const;
const recordFields = ['name', 'format', 'state', ['revision', 'Mutable revision'], 'head_id', 'current_url', 'accepted_version_url'] as const;
function page(title: string, value: unknown, keys: readonly Field[] = []): SemanticSection[] {
  if (value === undefined) return [];
  const p = asRecord(value);
  const items = p?.items;
  if (!Array.isArray(items)) return content(`${title} — presentation unavailable`, value);
  return [fields(`${title} — recorded coverage`, p, ['total', 'position', 'returned', 'next']), ...list(title, items, keys)];
}
function list(title: string, value: unknown, keys: readonly Field[] = []): SemanticSection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return content(`${title} — presentation unavailable`, value);
  return [{ title, items: value.map((item, index) => {
    const row = asRecord(item);
    if (typeof row?.content_hex === 'string') return { ...fields(`Partial JSON item ${index + 1} (not a complete observation)`, row, ['utf8_bytes', 'offset_bytes', 'next_offset_bytes', 'total_bytes']), content: row.content_hex };
    if (!row) return { title: `${title} ${index + 1}`, content: valueText(item), language: valueLanguage(item) };
    return fields(`${title} ${index + 1}`, row, keys);
  }) }];
}
function count(value: unknown, noun: string): string {
  const p = asRecord(value);
  return Array.isArray(value) ? `${value.length} ${noun} recorded` : typeof p?.returned === 'number'
    ? `${p.returned} of ${str(p.total)} selected ${noun}` : `${noun} not reported`;
}
function observed(headline: string, sections: SemanticSection[], outcome?: string, target?: InlinePart[]): ResultPresenterResult {
  return { headline: textPart(headline, 56), sections, outcome, target };
}
function collectionCoverage(value: unknown): string {
  const p = asRecord(value);
  const items = p?.items;
  const position = asRecord(p?.position);
  const partial = p?.next !== undefined && p.next !== null
    || typeof p?.returned === 'number' && typeof p.total === 'number' && p.returned < p.total
    || typeof position?.item_index === 'number' && position.item_index > 0
    || typeof position?.item_byte_offset === 'number' && position.item_byte_offset > 0;
  return [partial ? 'Partial coverage' : '', Array.isArray(items) && items.some((item) => asRecord(item)?.content_hex !== undefined) ? 'Partial JSON items' : ''].filter(Boolean).map((term) => ` · ${term}`).join('');
}
function sliceCoverage(value: unknown): string {
  const slice = asRecord(value);
  return slice && (typeof slice.offset_bytes === 'number' && slice.offset_bytes > 0 || typeof slice.next_offset_bytes === 'number' && typeof slice.total_bytes === 'number' && slice.next_offset_bytes < slice.total_bytes) ? ' · Partial content coverage' : '';
}
function request(action: string, keys: readonly Field[], target: (a: Facts) => InlinePart[], blocks: readonly Field[] = []): ToolPresenter['call'] {
  return (a) => ({ headline: target(a), sections: [fields(`Requested ${action}`, a, keys), ...blocks.flatMap((key) => {
    const [name, label] = typeof key === 'string' ? [key, key.replaceAll('_', ' ')] : key;
    return a[name] === undefined ? [] : [{ title: label, content: valueText(a[name]), language: valueLanguage(a[name]) }];
  })] });
}
function propagation(r: Facts | null): SemanticSection[] {
  const p = asRecord(r?.propagation);
  return p ? [fields('Propagation (separate from principal effect)', p, ['ok', 'partial', 'error'])] : [];
}
function propagationSummary(r: Facts | null): string {
  const p = asRecord(r?.propagation);
  return p?.partial === true || p?.ok === false ? ' · Partial propagation' : '';
}
function processResult(ctx: ResultPresenterContext): ResultPresenterResult {
  const r = ctx.dataRecord;
  if (!r) return observed('', [], 'Process observation not reported');
  const exit = r.exit_code;
  const outcome = r.status === 'running' ? 'Running at observation' : typeof exit === 'number'
    ? `${exit === 0 ? 'Exited' : 'Process failed'} · exit ${exit}${typeof r.status === 'string' && r.status !== 'exited' ? ` · recorded status: ${r.status}` : ''}` : typeof r.status === 'string' ? `Recorded process status: ${r.status}` : 'Presentation unavailable';
  const sections: SemanticSection[] = [fields('Recorded process', r, ['status', 'exit_code', 'process_id'])];
  for (const stream of ['stdout', 'stderr'] as const) {
    const link = processLogPart(r[`${stream}_url`], stream);
    sections.push({ ...fields(`${stream} — recorded head coverage`, r, [[`${stream}_complete`, 'Head complete'], [`${stream}_bytes`, 'Source bytes'], [`${stream}_url`, 'Output URL']]), ...(link ? { fields: [...fields('', r, [[`${stream}_complete`, 'Head complete'], [`${stream}_bytes`, 'Source bytes']]).fields!, { label: 'Output', parts: [link] }] } : {}) });
    sections.push(...content(stream, r[stream], true));
  }
  const coverage = r.stdout_complete === false || r.stderr_complete === false ? ' · Output head incomplete' : '';
  return { outcome: outcome + coverage, status: typeof exit === 'number' && exit !== 0 || r.status === 'failed' ? 'error' : 'neutral', headline: [], sections, target: textPart(r.process_id) };
}
function recordResult(r: Facts): ResultPresenterResult {
  const draft = r.state === 'open' && r.surface === 'card_agent';
  const accepted = r.state === 'closed' && r.surface === 'analyst';
  return observed(str(asRecord(r.propagation)?.error), [fields('Record mutation', r, ['card_id', 'name', 'state', 'surface', ['revision', 'Mutable revision'], 'head_id', 'current_url', ['accepted_version_url', draft ? 'Retained accepted version' : 'Accepted version'], 'bytes', 'written', 'code', 'reason', 'current_head', 'occurrences', 'replace_all_required', 'restart_required']), ...propagation(r)], (draft ? 'Draft updated' : accepted ? 'Record accepted' : r.code ? 'Refused' : 'Record mutation reported') + propagationSummary(r), summaryPathParts(r.current_url));
}
function fileMutation(ctx: ResultPresenterContext): ResultPresenterResult {
  const r = ctx.dataRecord;
  if (r && (r.surface !== undefined || r.code !== undefined)) return recordResult(r);
  const effect = ctx.name === 'write' ? r?.written : ctx.name === 'edit' ? r?.edited : r?.applied;
  const outcome = effect === true ? 'Applied' : effect === false ? 'Not applied'
    : ctx.envelope.success === false || r?.outcome_unknown === true ? undefined : 'Effect not reported';
  const detail = ctx.name === 'edit' && typeof r?.replacements === 'number' ? `${r.replacements} replacements` : ctx.name === 'apply_patch' ? count(r?.changed_files, 'changed paths') : typeof r?.bytes === 'number' ? `${r.bytes} bytes` : '';
  return observed(detail, [fields('Recorded file effect', r, ['destination_kind', 'target', 'path', 'bytes', 'written', 'replacements', 'edited', 'applied']), ...list('Changed paths (returned order)', r?.changed_files)], outcome, summaryPathParts(r?.target ?? r?.path));
}
function cardMutation(ctx: ResultPresenterContext): ResultPresenterResult {
  const r = ctx.dataRecord;
  const card = asRecord(r?.card);
  const lifecycle = asRecord(card?.lifecycle);
  const operatorSummary = asRecord(r?.operator_summary);
  const cardError = operatorSummary?.error ?? lifecycle?.error;
  const outcome = ctx.name === 'reorder_child' && typeof r?.changed === 'number' ? (r.changed === 0 ? 'Unchanged' : `Reordered · ${r.changed} changed`)
    : ctx.name === 'activate_card' ? str(r?.outcome) || 'Child outcome not reported'
      : ctx.name === 'delete_card' ? count(r?.deleted, 'deleted cards') : str(card?.status) || str(r?.status) || 'Card effect not reported';
  return observed(str(cardError ?? asRecord(r?.propagation)?.error), [fields('Recorded card', card, ['id', 'type', 'parent', 'status', 'title', 'depends_on', 'priority', 'urgency', 'version_seq', 'status_text']), fields('Recorded card lifecycle', lifecycle, ['status', 'result', 'error', 'completed_at']), fields('Recorded Analyst operator summary', operatorSummary, ['blocked', 'hasError', 'error', 'completedAt', 'stale']), fields('Recorded card effect', r, ['card_id', 'parent_id', 'parent', 'status', 'logical_path', 'outcome', 'summary', 'result', 'changed', 'reason', 'missing', 'extra']), ...list('Cancelled cards (returned order)', r?.cancelled_card_ids, ['card_id']), ...list('Deleted cards (returned order)', r?.deleted, ['card_id']), ...list('Top-level deleted roots', r?.top_level_deleted, ['card_id']), ...propagation(r)], outcome + (cardError || operatorSummary?.hasError === true ? ' · Card error recorded' : '') + (operatorSummary?.blocked === true ? ' · Blocked' : '') + propagationSummary(r), cardPart(card?.id ?? r?.card_id ?? r?.parent_id));
}
function readResult(ctx: ResultPresenterContext): ResultPresenterResult {
  const r = ctx.dataRecord;
  const observation = r && (Object.hasOwn(r, 'content') || r.entries !== undefined || r.records !== undefined);
  const state = [r?.metadata_only === true ? 'Metadata only' : '', r?.too_large === true ? 'Content omitted — too large' : ''].filter(Boolean).join(' · ')
    || (observation || ctx.envelope.success === true && r?.outcome_unknown !== true ? 'Read observation recorded' : '');
  const coverage = collectionCoverage(r?.entries ?? r?.records) + sliceCoverage(r?.content) + sliceCoverage(r?.path);
  const outcome = (state ? state + coverage : coverage.slice(3)) || undefined;
  const target = summaryPathParts(typeof r?.path === 'string' ? r.path : r?.record_url);
  return observed(str(r?.message) || (r?.entries !== undefined || r?.records !== undefined ? count(r?.entries ?? r?.records, 'entries') : typeof r?.total_bytes === 'number' ? `${r.total_bytes} source bytes` : 'Content coverage not reported'), [fields('Returned location and metadata', r, ['path', 'record_url', 'card_id', 'name', 'format', 'state', ['revision', 'Mutable revision'], 'head_id', 'version', 'accepted_version_url', 'committed_at', 'metadata_only', 'is_directory', 'entries_count', 'total_entries', 'size', 'mtime', 'total_bytes', 'too_large', 'max_bytes', 'message']), ...(asRecord(r?.path) ? content('Returned path slice', r?.path) : []), ...content('Recorded content', r?.content), ...page('Directory entries', r?.entries, ['name', 'type']), ...page('Records', r?.records, recordFields)], outcome, target);
}
function inspection(ctx: ResultPresenterContext): ResultPresenterResult {
  const r = ctx.dataRecord;
  const catalogKey = ({ list_cards: 'cards', get_tree: 'nodes', list_card_versions: 'versions' } as Facts)[ctx.name];
  const coverage = collectionCoverage(catalogKey ? r?.[String(catalogKey)] : r?.content) + sliceCoverage(r?.content ?? r?.diff);
  const nodes = asRecord(r?.nodes)?.items;
  const depthOmitted = Array.isArray(nodes) && nodes.some((node) => asRecord(node)?.depth_omitted === true);
  return observed(catalogKey ? count(r?.[String(catalogKey)], String(catalogKey)) : '', [fields('Selected card / immutable history', r, ['card_id', 'root_id', 'depth', 'section', 'head_id', ['version_seq', 'Current mutation revision'], ['version', 'Immutable history version'], 'entry_id', 'published_at', 'artifact_kind', 'artifact_sha256', 'observation_sha256', 'from_version', 'to_version', 'from_artifact', 'to_artifact', 'record_name', 'version_url', 'content_source', 'content_sha256', 'total_bytes', 'notification_recipient', 'planning_target', 'permitted_child_types', 'current_process_position']), fields('Recorded card summary', asRecord(r?.card), ['id', 'type', 'status', 'title', 'priority', 'urgency', 'parent', 'created_at', 'updated_at', 'status_text']), ...(catalogKey ? page(String(catalogKey), r?.[String(catalogKey)], catalogKey === 'versions' ? ['entry_id', ['version', 'Immutable history version'], 'published_at', 'artifact_kind', 'change'] : cardFields) : []), ...(asRecord(r?.content)?.items ? page(`Selected ${str(r?.section)} (returned order)`, r?.content, r?.section === 'records' ? recordFields : cardFields) : content('Selected content', r?.content)), ...content('Recorded diff (text slice)', r?.diff)], 'Observation recorded' + coverage + (depthOmitted ? ' · Depth omitted' : ''), cardPart(r?.card_id ?? r?.root_id ?? asRecord(r?.card)?.id));
}
function observation(ctx: ResultPresenterContext): ResultPresenterResult {
  const r = ctx.dataRecord;
  const key = ({ list_processes_tool: 'processes', list_agent_sessions: 'sessions', read_agent_session: r?.section === 'context' ? 'context' : 'messages', read_runtime_events: 'events', read_runtime_errors: 'errors', read_control_actions: 'actions' } as Facts)[ctx.name];
  const keys: readonly Field[] = ctx.name === 'list_processes_tool' ? ['id', 'status', 'command', 'cwd', 'exit_code', 'timed_out', 'started_at', 'ended_at', 'owner_kind', 'owner_id', 'card_id', 'session_id', 'logs']
    : ctx.name === 'list_agent_sessions' ? ['id', 'agent_name', 'session_scope', 'card_id', 'started_at', 'status', 'activity', 'compaction']
      : ctx.name === 'read_agent_session' ? r?.section === 'context' ? ['kind', 'source_version', 'covered_through_message_id', 'summary_text', 'protected_prompts', 'required_model_facts', 'continuation'] : ['id', 'role', 'kind', 'timestamp', 'content', 'tool', 'tool_call_id', 'context_policy', 'round_id', 'message_index', 'block_index', 'links']
        : ctx.name === 'read_control_actions' ? ['id', 'actor', 'surface', 'action', 'target_kind', 'target_id', 'params_summary', 'safety_class', 'outcome', 'outcome_summary', 'error', 'created_at']
          : ['id', 'timestamp', 'kind', 'goal_id', 'card_id', 'phase', 'error_message', 'actionable_error', 'server', 'tool', 'success', 'duration_ms', 'error', 'actor', 'surface', 'result'];
  const items = asRecord(r?.[String(key)])?.items;
  const first = Array.isArray(items) ? asRecord(items[0]) : null;
  const salient = first?.error_message ?? first?.error;
  const runtimeStatus = str(asRecord(r?.runtimeSummary)?.status);
  const outcome = !key && runtimeStatus ? `Observed ${runtimeStatus}` : 'Observation recorded';
  const tailCoverage = typeof r?.returned === 'number' && typeof r.total_lines === 'number' && r.returned < r.total_lines ? ' · Partial tail coverage' : '';
  return observed(salient ? str(salient) : key ? count(r?.[String(key)], String(key)) : '', [fields('Recorded observation (not a live monitor)', r, ['runtimeSummary', 'runtime', 'runningProcesses', 'statusCounts', 'counts', 'session', 'ownership', 'segment_version', 'segment_id', 'section', 'has_segment_context', ['total_visible_entries', 'Full visible message count'], ['total_lines', 'Full line count'], 'returned', 'parse_errors']), ...(key ? ctx.name === 'read_control_actions' ? list('Selected control actions', r?.actions, keys) : page(ctx.name.startsWith('read_') ? `Selected ${str(key)}` : str(key), r?.[String(key)], keys) : [])], outcome + collectionCoverage(r?.[String(key)]) + tailCoverage + (typeof r?.parse_errors === 'number' && r.parse_errors > 0 ? ' · Parse errors recorded' : ''));
}
function notification(ctx: ResultPresenterContext): ResultPresenterResult {
  const r = ctx.dataRecord;
  const interruption = asRecord(r?.interruption);
  const outcome = (r?.queued === true ? 'Queued · Delivery not reported' : r?.queued === false ? 'Queue refused' : 'Queue status not reported') + (interruption?.status ? ` · Interruption ${str(interruption.status)}` : '');
  return observed(str(interruption?.reason ?? r?.reason), [fields('Submission', r, ['queued', 'card_id', 'body', 'notification_id', 'reason', 'status']), fields('Interruption (not a delivery receipt)', interruption, ['status', 'reason', 'stopped_card_ids'])], outcome, cardPart(r?.card_id));
}
function control(ctx: ResultPresenterContext): ResultPresenterResult {
  const r = ctx.dataRecord;
  const outcome = ctx.name === 'restart_server' ? r?.restart === 'confirmation_required' ? 'Confirmation required' : r?.restart ? 'Restart requested · completion not reported' : 'Restart disposition not reported' : ctx.name === 'stop_project' && r?.contained === false ? 'Stopped · Not contained' : r?.status ? `Observed ${str(r.status)}` : 'Control response recorded';
  const state = ctx.name === 'start_project' && r?.started === true ? `Project started${r.stopped === true ? ' · Subsequently stopped' : ''}${r.contained === false ? ' · Not contained' : ''}` : outcome;
  return observed(str(r?.error), [fields('Recorded control response', r, ['status', 'runtime', 'runtime_status', 'started', 'stopped', 'contained', 'error', 'restart', 'confirmationMessage'])], state);
}
function webfetch(ctx: ResultPresenterContext): ResultPresenterResult {
  const r = ctx.dataRecord;
  if (r?.code !== undefined) return recordResult(r);
  const write = asRecord(r?.write);
  const saved = asRecord(write?.data);
  const mutation = saved ? write?.kind === 'record' ? recordResult(saved) : fileMutation({ ...ctx, name: 'write', dataRecord: saved }) : null;
  const link = webfetchContentPart(r?.content_url);
  const outcome = [r?.metadata_only === true ? 'Metadata only' : r?.binary === true ? 'Binary content omitted' : 'Fetch observation recorded', r?.fetch_truncated === true ? 'Fetch truncated' : '', r?.head_complete === false ? 'Text head incomplete' : '', mutation?.outcome ?? ''].filter(Boolean).join(' · ');
  return observed('', [fields('Fetch metadata and recorded coverage', r, ['redacted_url', 'status', 'headers', 'metadata_only', 'kind', 'binary', 'bytes', 'saved_as', 'head_utf8_bytes', 'redacted_text_utf8_bytes', 'fetched_text_utf8_bytes', 'head_complete', 'fetch_truncated', 'content_url']), ...content('Recorded text head', r?.head), ...(link ? [{ title: 'Returned text artifact', fields: [{ label: 'Files', parts: [link] }] }] : []), ...(mutation ? [{ title: `Save effect — ${str(write?.kind)}`, items: mutation.sections }] : [])], outcome, textPart(urlLabel(r?.redacted_url)));
}

const pathTarget = (a: Facts) => summaryPathParts(a.path);
const cardTarget = (a: Facts) => cardPart(a.card_id ?? a.cardId ?? a.id);
function scopedQuery(pattern: unknown, scope: unknown): InlinePart[] {
  if (!scope) return textPart(oneLine(pattern, 48));
  const scopeParts = pathParts(scope).map((part): InlinePart => part.kind === 'file'
    ? { ...part, label: pathLabel(scope, 21) } : { kind: 'text', text: pathLabel(scope, 21) });
  return [...textPart(oneLine(pattern, 24)), ...textPart(' · '), ...scopeParts];
}
function listTarget(value: unknown, noun: string): InlinePart[] {
  return textPart(Array.isArray(value) ? `${value.length} ${noun}${value.length ? ` · ${str(value[0])}` : ''}` : 'No targets supplied');
}
function navigationTarget(a: Facts): InlinePart[] {
  const target = asRecord(a.target);
  return textPart([str(target?.kind), str(target?.id), str(target?.refinement)].filter(Boolean).join(' · '));
}
const queryKeys = ['position', 'response_bytes', 'section', 'version', 'from_version', 'to_version', 'byte_offset', 'limit', 'since', 'kind', 'status', 'cardId', 'session_id', 'last_n', 'record_name', 'rootId', 'depth', 'type', 'parent'] as const;
export const TOOL_PRESENTERS: Readonly<Record<string, ToolPresenter>> = {
  run_command: { action: 'Run command', call: (a) => { const rendered = request('command', ['cwd', 'wait', 'timeout_ms'], (v) => textPart(v.command, 48), ['command'])(a); if (a.cwd === undefined) rendered.sections[0].fields!.push({ label: 'cwd', parts: textPart('Project workspace default') }); return rendered; }, result: processResult },
  wait_process: { action: 'Wait for process', call: request('wait', ['process_id', 'timeout_ms'], (a) => textPart(a.process_id)), result: processResult },
  kill_process: { action: 'Signal process', call: request('signal', ['process_id'], (a) => textPart(a.process_id)), result: processResult },
  read: { action: 'Read', call: request('read', ['path', 'read_mode', 'metadata_only', 'position', 'response_bytes'], pathTarget), result: readResult },
  view_image: { action: 'Inspect image', call: (a) => ({ headline: textPart(pathLabel(a.path)), sections: [{ title: 'Requested image inspection', fields: [{ label: 'path', parts: textPart(a.path) }, { label: 'max dimension', parts: textPart(a.max_dimension === undefined ? 'Local default 1600' : a.max_dimension) }] }] }), result: (ctx) => {
    if (ctx.envelope.success === false) return observed('', [], 'Image snapshot not recorded');
    const r = ctx.dataRecord;
    const dimensions = asRecord(r?.sent_dimensions);
    return observed(`sent ${str(dimensions?.width)} × ${str(dimensions?.height)}`, [fields('Recorded image snapshot (metadata only)', r, ['source_path', 'source_dimensions', 'oriented_dimensions', 'sent_dimensions', 'orientation_applied', 'resized', 'scale', 'max_dimension'])], 'Image snapshot recorded', textPart(pathLabel(r?.source_path)));
  } },
  glob: { action: 'Find paths', call: request('glob', ['directory', 'pattern', 'position', 'max_results', 'response_bytes'], (a) => scopedQuery(a.pattern, a.directory)), result: (ctx) => observed(count(ctx.dataRecord?.matches, 'matches'), page('Matching paths', ctx.dataRecord?.matches), 'Observation recorded' + collectionCoverage(ctx.dataRecord?.matches)) },
  grep: { action: 'Search text', call: request('grep', ['path', 'pattern', 'include', 'position', 'max_results', 'response_bytes'], (a) => scopedQuery(a.pattern, a.path)), result: (ctx) => observed(count(ctx.dataRecord?.matches, 'matches'), [fields('Search coverage', ctx.dataRecord, ['content_truncated', 'max_line_chars']), ...page('Matches', ctx.dataRecord?.matches, ['path', 'line', 'preview'])], 'Observation recorded' + (ctx.dataRecord?.content_truncated === true ? ' · Line content truncated' : '') + collectionCoverage(ctx.dataRecord?.matches)) },
  write: { action: 'Write', call: request('write', ['path'], pathTarget, [['content', 'Supplied content']]), result: fileMutation },
  edit: { action: 'Replace text', call: request('replacement (not a full before/after snapshot)', ['path', 'replace_all'], pathTarget, [['old_string', 'Supplied old string'], ['new_string', 'Supplied new string']]), result: fileMutation },
  apply_patch: { action: 'Apply patch', call: request('patch', [], () => textPart('Project files'), [['patch', 'Full supplied patch']]), result: fileMutation },
  create_card: { action: 'Create card', call: request('card creation', ['title', 'type', 'parent', 'priority', 'urgency', 'depends_on'], (a) => textPart(a.title, 48), [['bootstrap_content', 'Bootstrap content']]), result: cardMutation },
  edit_card: { action: 'Edit card', call: request('card edit', ['card_id', 'title', 'depends_on', 'priority', 'urgency'], cardTarget), result: cardMutation },
  reorder_child: { action: 'Reorder children', call: request('sibling order', ['parentId', 'orderedChildIds'], (a) => listTarget(a.orderedChildIds, 'children')), result: cardMutation },
  reopen_card: { action: 'Reopen card', call: request('reopen', ['card_id', 'cardId'], cardTarget), result: cardMutation },
  cancel_card: { action: 'Cancel card', call: request('cancel', ['card_id', 'cardId', 'reason'], cardTarget), result: cardMutation },
  delete_card: { action: 'Delete card roots', call: request('root deletion', ['ids'], (a) => listTarget(a.ids, 'roots')), result: cardMutation },
  activate_card: { action: 'Activate child', call: request('activation', ['card_id'], cardTarget), result: cardMutation },
  queue_notification: { action: 'Queue notification', call: request('notice', ['card_id', 'kind', 'urgency'], cardTarget, [['body', 'Full notice body']]), result: notification },
  emit_result: { action: 'Submit node result', call: request('node result', ['outcome'], (a) => textPart(a.outcome), ['summary']), result: (ctx) => observed('', [fields('Recorded node admission', ctx.dataRecord, ['accepted', 'outcome', 'summary', 'status'])], ctx.envelope.success === true ? 'Node result accepted' : 'Node result rejected') },
  start_project: { action: 'Start project', call: request('start', [], () => textPart('Project')), result: control },
  pause_runtime: { action: 'Pause runtime', call: request('pause', [], () => textPart('Runtime')), result: control },
  resume_runtime: { action: 'Resume runtime', call: request('resume', [], () => textPart('Runtime')), result: control },
  stop_project: { action: 'Stop project', call: request('stop', [], () => textPart('Project')), result: control },
  restart_server: { action: 'Request server restart', call: request('restart', [], () => textPart('Server')), result: control },
  navigate_workspace: { action: 'Publish navigation', call: request('navigation intent', ['target'], navigationTarget), result: (ctx) => observed('', [fields('Published navigation intent', ctx.dataRecord, ['intent', 'target'])], 'Navigation intent published · Browser receipt not reported') },
  navigate_back: { action: 'Publish back navigation', call: request('back navigation', [], () => textPart('Back')), result: (ctx) => observed('', [fields('Navigation publication', ctx.dataRecord, ['intent'])], 'Navigation intent published · Browser receipt not reported') },
  list_cards: { action: 'List cards', call: request('card query', [...queryKeys, 'statuses'], () => textPart('Cards')), result: inspection },
  get_card: { action: 'Inspect card', call: request('card section', ['id', ...queryKeys], cardTarget), result: inspection },
  get_tree: { action: 'Inspect tree', call: request('tree query', queryKeys, (a) => cardPart(a.rootId)), result: inspection },
  list_card_versions: { action: 'List immutable versions', call: request('version catalog', ['card_id', ...queryKeys], cardTarget), result: inspection },
  get_card_version: { action: 'Read immutable card version', call: request('immutable version', ['card_id', ...queryKeys], cardTarget), result: inspection },
  diff_card_versions: { action: 'Compare immutable versions', call: request('version range', ['card_id', ...queryKeys], cardTarget), result: inspection },
  read_record_version: { action: 'Read accepted record version', call: request('accepted source version', ['card_id', ...queryKeys], (a) => a.record_name ? [...textPart(oneLine(a.record_name, 24)), ...textPart(' · '), ...cardTarget(a)] : cardTarget(a)), result: inspection },
  get_status: { action: 'Observe status', call: request('status', [], () => textPart('Project / runtime')), result: observation },
  list_processes_tool: { action: 'Observe processes', call: request('process query', queryKeys, () => textPart('Processes')), result: observation },
  list_agent_sessions: { action: 'Observe sessions', call: request('session query', queryKeys, () => textPart('Agent sessions')), result: observation },
  read_agent_session: { action: 'Read selected session', call: request('session section', queryKeys, (a) => textPart(a.session_id)), result: observation },
  read_runtime_events: { action: 'Read event tail', call: request('selected newest events', queryKeys, () => textPart('Runtime events')), result: observation },
  read_runtime_errors: { action: 'Read error tail', call: request('selected newest errors', queryKeys, () => textPart('Runtime errors')), result: observation },
  read_control_actions: { action: 'Read control audit tail', call: request('selected control actions', queryKeys, () => textPart('Control actions')), result: observation },
  websearch: { action: 'Search web', call: request('search', ['query', 'max_results'], (a) => textPart(a.query, 48)), result: (ctx) => observed(count(ctx.dataRecord?.results, 'search results'), [fields('Search query', ctx.dataRecord, ['query']), ...list('Search results', ctx.dataRecord?.results, ['title', 'url', 'snippet'])], 'Observation recorded') },
  webfetch: { action: 'Fetch URL', call: request('fetch', ['url', 'metadata_only', 'read_mode', 'save_as', 'max_bytes', 'max_inline_bytes'], (a) => textPart(urlLabel(a.url))), result: webfetch },
  skill: { action: 'Load / list skills', call: request('skill', ['name'], (a) => textPart(a.name ?? 'Available skills')), result: (ctx) => observed(ctx.dataRecord?.skill_name ? 'Instructions returned' : count(ctx.dataRecord?.skills, 'skills'), [...list('Available skills', ctx.dataRecord?.skills, ['name', 'description']), ...content('Skill name', ctx.dataRecord?.skill_name), ...content('Skill instructions', ctx.dataRecord?.skill_content)], 'Observation recorded', textPart(ctx.dataRecord?.skill_name)) },
  show_config: { action: 'Inspect projected config', call: request('config inspection', [], () => textPart('Safe configuration')), result: (ctx) => { const config = asRecord(ctx.dataRecord?.config); return observed('', [fields('Server settings', asRecord(config?.server), ['host', 'port']), fields('Agent / workflow configuration', config, ['agents', 'analyst_agent', 'oversight', 'card_types']), fields('Model routing', asRecord(config?.models), ['routes', 'profiles', 'equivalents', 'failover']), fields('Projected providers / MCP', config, ['providers', 'mcpServers']), fields('Compaction settings', asRecord(config?.compaction), ['enabled', 'context_utilization_fraction', 'trigger_fraction', 'tail_fraction', 'snap', 'summarizer_candidate'])], 'Observation recorded'); } },
  reconfigure: { action: 'Request config change', call: request('config action', ['action', 'agent', 'model_route', 'for_model', 'ordered_failover_models', 'key', 'value'], (a) => textPart([oneLine(a.action, 28), oneLine(a.agent ?? a.model_route ?? a.key ?? '', 17)].filter(Boolean).join(' · '))), result: (ctx) => observed('', [fields('Recorded configuration action', ctx.dataRecord, ['applied', 'requires_restart', 'action', 'agent', 'model_route', 'for_model', 'ordered_failover_models', 'key', 'value'])], ctx.dataRecord?.applied === true ? `Action applied${ctx.dataRecord.requires_restart === true ? ' · Requires restart' : ''}` : ctx.dataRecord?.requires_restart === true ? 'Requires restart' : 'Action outcome not reported', textPart(ctx.dataRecord?.action)) },
  mcp_tool_call: { action: 'Invoke MCP tool', call: request('MCP invocation', ['serverName', 'toolName', 'max_dimension'], (a) => textPart(`${str(a.serverName)}/${str(a.toolName)}`), [['args', 'Safe MCP arguments']]), result: (ctx) => observed('', [...content('MCP envelope metadata (effects opaque)', ctx.dataRecord?.result), ...content('MCP native block metadata', ctx.dataRecord?.native_content), ...list('MCP image capture metadata', ctx.dataRecord?.images, ['content_index', 'source_dimensions', 'oriented_dimensions', 'sent_dimensions', 'orientation_applied', 'resized', 'scale', 'max_dimension']), ...content('MCP diagnostic content', ctx.dataRecord?.content)], 'Observation recorded · Effects opaque') },
  mcp_server_control: { action: 'Control MCP server', call: request('MCP server control', ['serverName', 'action'], (a) => textPart(str(a.serverName))), result: (ctx) => observed('', [fields('Recorded MCP lifecycle outcome', ctx.dataRecord, ['serverName', 'status', 'toolCount'])], ctx.dataRecord?.status === 'running' ? 'Server ready' : ctx.dataRecord?.status === 'stopped' ? 'Server stopped · Context may be lost' : 'Outcome not reported') },
  mcp_tools: { action: 'Discover MCP tools', call: request('MCP discovery', ['serverName', 'toolName'], (a) => textPart(str(a.serverName))), result: (ctx) => observed('', [fields('Recorded MCP discovery', ctx.dataRecord, ['serverName']), ...list('Discovered tools', ctx.dataRecord?.tools, ['name', 'description', 'inputSchema'])], count(ctx.dataRecord?.tools, 'tools')) },
};
export function getToolPresenter(name: string): ToolPresenter | undefined {
  return Object.hasOwn(TOOL_PRESENTERS, name) ? TOOL_PRESENTERS[name] : undefined;
}
