// Rich custom representations for common Saivage agent tools.
//
// Both AgentConversationView and AnalystChatPanel show agent timelines as
// `kind: 'tool_call'` and `kind: 'tool_result'` messages. Their raw content is
// JSON that is dull to skim. This module returns a typed { icon, headline, args, detail }
// shape that callers render into chips. Unknown tools fall back to a generic
// "name(arg keys)" preview so this stays additive.

const RESULT_ICON_OK = '↩';
const RESULT_ICON_ERR = '⚠';

export interface ToolCallPresentation {
  icon: string;
  name: string;
  /** Inline chip subtitle ("path", "command", "card id"). May be empty. */
  headline: string;
  /** Optional secondary line for the chip ("title", "tags"). May be empty. */
  detail?: string;
}

export interface ToolResultPresentation {
  icon: string;
  status: 'ok' | 'error';
  name: string;
  /** Short outcome summary ("42 lines, 1.2 kB", "exit 0"). */
  headline: string;
  detail?: string;
}

export function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseArgs(value: unknown): unknown {
  if (typeof value === 'string') return safeJsonParse(value) ?? value;
  return value;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

function oneLine(value: unknown, max = 72): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return truncate(text.replace(/\s+/g, ' '), max);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortPath(path: string): string {
  if (!path) return '';
  return truncate(path, 64);
}

function argKeys(args: unknown): string {
  const record = asRecord(args);
  return record ? Object.keys(record).join(', ') : '';
}

interface ToolCallEnvelope {
  name: string;
  args: unknown;
}

/** Extract the first tool call envelope from a tool_call message body. */
export function readToolCallEnvelope(rawContent: string, fallbackName?: string): ToolCallEnvelope {
  const parsed = asRecord(safeJsonParse(rawContent));
  const toolCalls = Array.isArray(parsed?.toolCalls) ? parsed.toolCalls : [];
  const first = asRecord(toolCalls[0]);
  const fn = asRecord(first?.function);
  const name = typeof fn?.name === 'string'
    ? fn.name
    : typeof first?.tool === 'string'
      ? first.tool
      : fallbackName ?? 'tool_call';
  const args = fn && 'arguments' in fn ? parseArgs(fn.arguments) : parseArgs(first?.params ?? {});
  return { name, args };
}

// ── Tool call presenters ───────────────────────────────────────────────

type CallPresenter = (args: Record<string, unknown>) => { icon: string; headline: string; detail?: string };

const CALL_PRESENTERS: Record<string, CallPresenter> = {
  read_project_file: (a) => ({ icon: '📖', headline: shortPath(str(a.path)) }),
  read_file: (a) => ({ icon: '📖', headline: shortPath(str(a.path)) }),
  list_project_files: (a) => ({ icon: '📂', headline: shortPath(str(a.path ?? a.dir ?? '.')) }),
  list_directory: (a) => ({ icon: '📂', headline: shortPath(str(a.path ?? '.')) }),
  write_project_file: (a) => {
    const path = shortPath(str(a.path));
    const content = str(a.content);
    return { icon: '✏️', headline: path, detail: content ? `${content.length} chars` : undefined };
  },
  run_project_command: (a) => ({ icon: '⚡', headline: oneLine(a.command, 80) }),
  run_shell_command: (a) => ({ icon: '⚡', headline: oneLine(a.command, 80) }),
  start_and_wait: (a) => ({ icon: '⚡', headline: oneLine(a.command, 80) }),
  wait_for_process: (a) => ({ icon: '⏳', headline: `process ${str(a.processId)}` }),
  kill_process: (a) => ({ icon: '🛑', headline: `process ${str(a.processId)}` }),

  activate_card: (a) => ({ icon: '▶', headline: `card ${str(a.cardId)}` }),
  cancel_card: (a) => ({ icon: '⏹', headline: `card ${str(a.cardId)}` }),
  restart_card: (a) => ({ icon: '↻', headline: `card ${str(a.cardId ?? a.id)}` }),
  delete_card: (a) => ({ icon: '🗑', headline: `card ${str(a.cardId ?? a.id)}` }),
  create_card: (a) => {
    const type = str(a.type);
    const title = oneLine(a.title, 64);
    const parent = str(a.parent);
    return {
      icon: '➕',
      headline: title || (type ? `${type} card` : 'new card'),
      detail: [type, parent ? `parent ${parent}` : null].filter(Boolean).join(' · ') || undefined,
    };
  },
  edit_card: (a) => {
    const id = str(a.id);
    const keys = Object.keys(a).filter((key) => key !== 'id');
    return { icon: '✎', headline: `card ${id}`, detail: keys.length > 0 ? `change ${keys.join(', ')}` : undefined };
  },
  move_card: (a) => ({ icon: '↳', headline: `card ${str(a.id)} → ${str(a.newParent) || 'root'}` }),
  get_card: (a) => ({ icon: '🔎', headline: `card ${str(a.id)}` }),
  list_cards: (a) => {
    const filters = Object.entries(a).filter(([, value]) => value !== undefined && value !== null && value !== '');
    return { icon: '🔎', headline: filters.length === 0 ? 'all cards' : filters.map(([key, value]) => `${key}=${str(value)}`).join(' · ') };
  },
  get_tree: (a) => ({ icon: '🌳', headline: a.rootId ? `subtree ${str(a.rootId)}` : 'project tree' }),
  get_status: () => ({ icon: '📊', headline: 'project status' }),
  get_plan_diary: (a) => ({ icon: '📔', headline: `goal ${str(a.goalId)}` }),
  get_card_output: (a) => ({ icon: '🖥', headline: `card ${str(a.cardId)}${a.lines ? ` · last ${str(a.lines)} lines` : ''}` }),

  report_goal_done: (a) => ({ icon: '✅', headline: oneLine(a.status_text ?? a.summary ?? 'goal done', 96) }),
  report_goal_failed: (a) => ({ icon: '❌', headline: oneLine(a.status_text ?? a.summary ?? 'goal failed', 96) }),
  report_goal_blocked: (a) => ({ icon: '⛔', headline: oneLine(a.status_text ?? a.summary ?? 'goal blocked', 96) }),
  mark_goal_needs_corrections: (a) => {
    const issues = Array.isArray(a.issues) ? a.issues.length : 0;
    return { icon: '⚠', headline: `goal ${str(a.goalId)}`, detail: issues > 0 ? `${issues} issue${issues === 1 ? '' : 's'}` : undefined };
  },

  add_note: (a) => ({ icon: '📝', headline: `card ${str(a.cardId)}${a.kind ? ` [${str(a.kind)}]` : ''}`, detail: oneLine(a.content, 96) }),
  list_notes: (a) => ({ icon: '📋', headline: `card ${str(a.cardId)}` }),
  get_note: (a) => ({ icon: '📋', headline: `note ${str(a.noteId)} on ${str(a.cardId)}` }),
  mark_note_handled: (a) => ({ icon: '✓', headline: `note ${str(a.noteId)}` }),

  read_runtime_events: (a) => ({ icon: '📜', headline: `events × ${str(a.limit ?? 50)}${a.kind ? ` [${str(a.kind)}]` : ''}` }),
  read_runtime_errors: (a) => ({ icon: '🩺', headline: `errors × ${str(a.limit ?? 50)}` }),
  read_control_actions: (a) => ({ icon: '🧭', headline: `control actions × ${str(a.limit ?? 50)}` }),
  list_processes_tool: (a) => ({ icon: '⚙', headline: a.status || a.cardId ? `filter ${argKeys(a)}` : 'all processes' }),
  list_agent_sessions: () => ({ icon: '👥', headline: 'agent sessions' }),
  read_agent_session: (a) => ({ icon: '🧵', headline: `session ${str(a.sessionId)}` }),

  pause_runtime: () => ({ icon: '⏸', headline: 'pause runtime' }),
  resume_runtime: () => ({ icon: '▶', headline: 'resume runtime' }),
  abort_goal: (a) => ({ icon: '⛔', headline: `goal ${str(a.goalId)}` }),
  restart_goal: (a) => ({ icon: '↻', headline: `goal ${str(a.goalId)}` }),

  load_skill: (a) => ({ icon: '🪄', headline: str(a.name ?? a.skill ?? 'skill') }),
  mcp_tool_call: (a) => ({ icon: '🔌', headline: str(a.tool ?? a.name ?? 'mcp'), detail: oneLine(a.params ?? a.arguments ?? '', 72) || undefined }),
  list_card_history: (a) => ({ icon: '🕘', headline: `card ${str(a.cardId)}` }),
  get_card_history_entry: (a) => ({ icon: '🕘', headline: `card ${str(a.cardId)} @ v${str(a.version_seq)}` }),
  diff_card: (a) => ({ icon: '🔀', headline: `card ${str(a.cardId)}` }),
};

export function presentToolCall(rawContent: string, fallbackName?: string): ToolCallPresentation {
  const envelope = readToolCallEnvelope(rawContent, fallbackName);
  const argsRecord = asRecord(envelope.args) ?? {};
  const presenter = CALL_PRESENTERS[envelope.name];
  if (presenter) {
    const { icon, headline, detail } = presenter(argsRecord);
    return { icon, name: envelope.name, headline, detail };
  }
  const keys = argKeys(argsRecord);
  return {
    icon: '🔧',
    name: envelope.name,
    headline: keys ? `(${keys})` : '',
    detail: oneLine(envelope.args, 96) || undefined,
  };
}

// ── Tool result presenters ─────────────────────────────────────────────

interface ResultContext {
  name: string;
  status: 'ok' | 'error';
  parsed: unknown;
  record: Record<string, unknown> | null;
  rawContent: string;
}

type ResultPresenter = (ctx: ResultContext) => { headline: string; detail?: string };

const RESULT_PRESENTERS: Record<string, ResultPresenter> = {
  read_project_file: (ctx) => {
    const record = ctx.record;
    if (!record) return { headline: oneLine(ctx.rawContent, 96) };
    if (record.binary === true) return { headline: 'binary file' };
    const content = typeof record.content === 'string' ? record.content : '';
    const bytes = typeof record.bytes === 'number' ? record.bytes : content.length;
    const lines = content ? content.split('\n').length : (typeof record.lines === 'number' ? record.lines : 0);
    return { headline: lines ? `${lines} lines · ${formatBytes(bytes)}` : formatBytes(bytes) };
  },
  read_file: (ctx) => RESULT_PRESENTERS.read_project_file(ctx),
  write_project_file: (ctx) => {
    const record = ctx.record;
    const bytes = typeof record?.bytes === 'number' ? record.bytes : null;
    return { headline: bytes !== null ? `wrote ${formatBytes(bytes)}` : 'wrote file' };
  },
  list_project_files: (ctx) => {
    const record = ctx.record;
    const entries = Array.isArray(record?.entries) ? record!.entries.length : Array.isArray(record?.files) ? record!.files.length : null;
    return { headline: entries !== null ? `${entries} entr${entries === 1 ? 'y' : 'ies'}` : oneLine(ctx.rawContent, 96) };
  },
  list_directory: (ctx) => RESULT_PRESENTERS.list_project_files(ctx),
  run_project_command: (ctx) => {
    const record = ctx.record;
    const exit = typeof record?.exitCode === 'number' ? record.exitCode : typeof record?.exit_code === 'number' ? record.exit_code : null;
    const status = typeof record?.status === 'string' ? record.status : null;
    const timedOut = record?.timedOut === true || record?.timed_out === true;
    const procId = typeof record?.id === 'string' ? record.id : typeof record?.processId === 'string' ? record.processId : null;
    const parts = [];
    if (exit !== null) parts.push(`exit ${exit}`);
    if (status) parts.push(status);
    if (timedOut) parts.push('timed out');
    return { headline: parts.length > 0 ? parts.join(' · ') : 'completed', detail: procId ? `process ${procId}` : undefined };
  },
  run_shell_command: (ctx) => RESULT_PRESENTERS.run_project_command(ctx),
  start_and_wait: (ctx) => RESULT_PRESENTERS.run_project_command(ctx),
  wait_for_process: (ctx) => RESULT_PRESENTERS.run_project_command(ctx),
  kill_process: (ctx) => {
    const record = ctx.record;
    return { headline: record?.killed === true ? 'killed' : 'process signalled' };
  },

  activate_card: (ctx) => describeCardOutcome(ctx, 'activated'),
  cancel_card: (ctx) => describeCardOutcome(ctx, 'cancelled'),
  restart_card: (ctx) => describeCardOutcome(ctx, 'restarted'),
  delete_card: (ctx) => describeCardOutcome(ctx, 'deleted'),
  create_card: (ctx) => describeCardOutcome(ctx, 'created'),
  edit_card: (ctx) => describeCardOutcome(ctx, 'edited'),
  move_card: (ctx) => describeCardOutcome(ctx, 'moved'),
  get_card: (ctx) => {
    const card = asRecord(ctx.record?.card) ?? ctx.record;
    if (!card) return { headline: oneLine(ctx.rawContent, 96) };
    const title = str(card.title);
    const status = str(card.status);
    const type = str(card.type);
    return { headline: title ? `${title}` : `card ${str(card.id)}`, detail: [type, status].filter(Boolean).join(' · ') || undefined };
  },
  list_cards: (ctx) => {
    const cards = Array.isArray(ctx.record?.cards) ? ctx.record!.cards : Array.isArray(ctx.parsed) ? ctx.parsed as unknown[] : null;
    return { headline: cards ? `${cards.length} card${cards.length === 1 ? '' : 's'}` : oneLine(ctx.rawContent, 96) };
  },
  get_tree: (ctx) => {
    const tree = ctx.record?.tree ?? ctx.record;
    if (!tree) return { headline: oneLine(ctx.rawContent, 96) };
    return { headline: 'tree fetched' };
  },

  report_goal_done: () => ({ headline: 'recorded done report' }),
  report_goal_failed: () => ({ headline: 'recorded failed report' }),
  report_goal_blocked: () => ({ headline: 'recorded blocked report' }),
  mark_goal_needs_corrections: () => ({ headline: 'corrections queued' }),

  add_note: (ctx) => {
    const id = str(ctx.record?.noteId ?? ctx.record?.id);
    return { headline: id ? `note ${id}` : 'note added' };
  },
  list_notes: (ctx) => {
    const notes = Array.isArray(ctx.record?.notes) ? ctx.record!.notes : null;
    return { headline: notes ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : oneLine(ctx.rawContent, 96) };
  },
  mark_note_handled: () => ({ headline: 'note handled' }),

  read_runtime_events: (ctx) => describeJsonlTail(ctx, 'events'),
  read_runtime_errors: (ctx) => describeJsonlTail(ctx, 'errors'),
  read_control_actions: (ctx) => describeJsonlTail(ctx, 'control actions'),
  list_processes_tool: (ctx) => {
    const list = Array.isArray(ctx.record?.processes) ? ctx.record!.processes : Array.isArray(ctx.parsed) ? ctx.parsed as unknown[] : null;
    return { headline: list ? `${list.length} process${list.length === 1 ? '' : 'es'}` : oneLine(ctx.rawContent, 96) };
  },
  list_agent_sessions: (ctx) => {
    const list = Array.isArray(ctx.record?.sessions) ? ctx.record!.sessions : Array.isArray(ctx.parsed) ? ctx.parsed as unknown[] : null;
    return { headline: list ? `${list.length} session${list.length === 1 ? '' : 's'}` : oneLine(ctx.rawContent, 96) };
  },
  read_agent_session: (ctx) => {
    const messages = Array.isArray(ctx.record?.messages) ? ctx.record!.messages : null;
    return { headline: messages ? `${messages.length} message${messages.length === 1 ? '' : 's'}` : oneLine(ctx.rawContent, 96) };
  },

  load_skill: (ctx) => {
    const name = str(ctx.record?.name ?? ctx.record?.skill);
    return { headline: name ? `loaded ${name}` : 'skill loaded' };
  },
  mcp_tool_call: (ctx) => ({ headline: oneLine(ctx.record?.summary ?? ctx.record?.result ?? ctx.parsed ?? ctx.rawContent, 96) }),
};

function describeCardOutcome(ctx: ResultContext, defaultVerb: string): { headline: string; detail?: string } {
  const record = ctx.record;
  const card = asRecord(record?.card);
  const id = str(card?.id ?? record?.cardId ?? record?.id);
  const status = str(card?.status ?? record?.status);
  const summary = str(record?.summary ?? record?.message);
  if (summary) return { headline: oneLine(summary, 96), detail: status || (id ? `card ${id}` : undefined) };
  if (id) return { headline: `${defaultVerb} ${id}`, detail: status || undefined };
  return { headline: defaultVerb };
}

function describeJsonlTail(ctx: ResultContext, label: string): { headline: string; detail?: string } {
  const record = ctx.record;
  const entries = Array.isArray(record?.entries) ? record!.entries : Array.isArray(ctx.parsed) ? ctx.parsed as unknown[] : null;
  if (!entries) return { headline: oneLine(ctx.rawContent, 96) };
  return { headline: `${entries.length} ${label}` };
}

function resolveResultName(rawContent: string, fallbackName?: string): string {
  const record = asRecord(safeJsonParse(rawContent));
  return fallbackName
    ?? (typeof record?.tool === 'string' ? record.tool : undefined)
    ?? (typeof record?.toolName === 'string' ? record.toolName : undefined)
    ?? 'tool';
}

export function presentToolResult(rawContent: string, opts: { tool?: string; kind?: string } = {}): ToolResultPresentation {
  const name = resolveResultName(rawContent, opts.tool);
  const parsed = safeJsonParse(rawContent);
  const record = asRecord(parsed);
  const isError = opts.kind === 'tool_error' || record?.ok === false || typeof record?.error === 'string';
  const status: 'ok' | 'error' = isError ? 'error' : 'ok';
  const ctx: ResultContext = { name, status, parsed, record, rawContent };

  if (status === 'error') {
    const message = str(record?.error ?? record?.message ?? parsed ?? rawContent);
    return { icon: RESULT_ICON_ERR, status, name, headline: oneLine(message, 120) };
  }

  const presenter = RESULT_PRESENTERS[name];
  if (presenter) {
    const { headline, detail } = presenter(ctx);
    return { icon: RESULT_ICON_OK, status, name, headline, detail };
  }

  const summary = str(record?.summary ?? record?.message ?? record?.content ?? parsed ?? rawContent);
  return { icon: RESULT_ICON_OK, status, name, headline: oneLine(summary, 120) };
}
