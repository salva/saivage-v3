import type { InlinePart } from './tool-presenters';
import type { ToolPair, ToolGroup, ToolListItem } from './agent-timeline/types';
import { presentToolCall, presentToolResult } from './tool-presenters';

export type ToolTone = 'neutral' | 'ok' | 'warn' | 'error' | 'pending';

const FRIENDLY_ACTIONS: Record<string, string> = {
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  write: 'Write',
  edit: 'Edit',
  apply_patch: 'Patch',
  run_command: 'Shell',
  wait_process: 'Wait',
  kill_process: 'Kill',
  websearch: 'Search',
  webfetch: 'Fetch',
  activate_card: 'Activate',
  cancel_card: 'Cancel',
  restart_card: 'Restart',
  delete_card: 'Delete',
  create_card: 'Create',
  edit_card: 'Edit card',
  emit_result: 'Complete',
  get_card: 'Inspect',
  get_card_output: 'Output',
  get_status: 'Status',
  get_tree: 'Tree',
  list_cards: 'List cards',
  list_processes_tool: 'List processes',
  list_agent_sessions: 'List sessions',
  list_card_history: 'History',
  get_card_history_entry: 'History',
  diff_card: 'Diff',
  read_agent_session: 'Session',
  read_runtime_events: 'Events',
  read_runtime_errors: 'Errors',
  read_control_actions: 'Audit',
  pause_runtime: 'Pause',
  resume_runtime: 'Resume',
  skill: 'Skill',
  mcp_tool_call: 'MCP',
};

const KNOWN_TOOLS = new Set<string>(Object.keys(FRIENDLY_ACTIONS));

export function isKnownTool(name: string): boolean {
  return KNOWN_TOOLS.has(name);
}

export function friendlyAction(name: string): string {
  const mapped = FRIENDLY_ACTIONS[name];
  if (mapped) return mapped;
  if (name.startsWith('mcp__') || name.startsWith('mcp_tool_call')) return 'MCP';
  const last = name.split(/[._/]/).filter(Boolean).pop() ?? name;
  const head = last.charAt(0).toUpperCase();
  return head + last.slice(1);
}

function isInteractive(part: InlinePart): boolean {
  return part.kind === 'file' || part.kind === 'url' || part.kind === 'card';
}

function inlineText(parts: InlinePart[]): string {
  return parts
    .map((part) => {
      if (part.kind === 'text') return part.text;
      if (part.kind === 'code') return part.code;
      if (part.kind === 'file') return part.label ?? part.path;
      if (part.kind === 'url') return part.label ?? part.href;
      return part.fallbackLabel ?? part.id;
    })
    .join('')
    .trim();
}

function firstLine(value: string, max = 120): string {
  const line = value.split(/\r?\n/)[0] ?? '';
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function errorFirstLine(resultContent: string | null): string {
  if (!resultContent) return 'error';
  try {
    const parsed = JSON.parse(resultContent) as unknown;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const err = obj.error;
      if (typeof err === 'string') return firstLine(err) || 'error';
      if (err && typeof err === 'object') {
        const nested = err as Record<string, unknown>;
        const msg = String(nested.message ?? nested.code ?? '');
        if (msg) return firstLine(msg);
      }
      const code = typeof obj.code === 'string' ? obj.code : '';
      if (code) return firstLine(code);
    }
  } catch {
    // fall through to raw first line
  }
  const line = firstLine(resultContent);
  return line || 'error';
}

export interface ToolDisplayModel {
  action: string;
  toolName: string;
  target: InlinePart[];
  links: InlinePart[];
  status: InlinePart[];
  statusTone: ToolTone;
  known: boolean;
}

/**
 * Build the single tool display model directly from a paired tool call/result.
 * The per-tool presenters parse the raw payloads; this function derives the
 * compact row grammar (`Action target… status`) plus the raw tool name in one
 * pass. `ToolChip` consumes this model as a dumb renderer.
 */
export function buildToolDisplay(pair: ToolPair): ToolDisplayModel {
  const callPres = presentToolCall(pair.call.content);
  const result = pair.result;
  const resultPres = result ? presentToolResult(result.content, { tool: result.tool, kind: result.kind }) : null;
  const resultContent = result?.content ?? null;
  const status = pair.status;

  const action = friendlyAction(callPres.name);
  const known = isKnownTool(callPres.name);
  const callParts = [...callPres.headline, ...(callPres.detail ?? [])];
  const target = callParts.filter((part) => !isInteractive(part));
  let links = callParts.filter(isInteractive);

  let statusParts: InlinePart[] = [];
  let statusTone: ToolTone = 'neutral';

  if (status === 'pending') {
    statusParts = [{ kind: 'text', text: 'running…' }];
    statusTone = 'pending';
  } else if (status === 'error') {
    statusParts = [{ kind: 'text', text: errorFirstLine(resultContent) }];
    statusTone = 'error';
  } else {
    const resultParts = [...(resultPres?.headline ?? []), ...(resultPres?.detail ?? [])];
    const text = inlineText(resultParts);
    if (text) {
      statusParts = resultParts.filter((part) => !isInteractive(part));
      statusTone = 'ok';
    }
    const linkExtras = resultParts.filter(isInteractive);
    if (linkExtras.length) links.push(...linkExtras);
  }

  return { action, toolName: callPres.name, target, links, status: statusParts, statusTone, known };
}

const GROUPABLE_TOOLS = new Set<string>([
  'read', 'glob', 'grep',
  'websearch', 'webfetch',
  'get_card', 'get_tree', 'get_status', 'get_card_output',
  'list_cards', 'list_agent_sessions', 'list_card_history',
  'read_agent_session', 'read_runtime_events', 'read_runtime_errors', 'read_control_actions',
  'get_card_history_entry', 'diff_card', 'skill',
]);

const WEB_TOOLS = new Set<string>(['websearch', 'webfetch']);

export function isGroupable(pair: ToolPair): boolean {
  if (pair.status !== 'ok') return false;
  const name = pair.call.tool ?? '';
  return GROUPABLE_TOOLS.has(name);
}

function groupKeyFor(pair: ToolPair): string | null {
  if (!isGroupable(pair)) return null;
  return WEB_TOOLS.has(pair.call.tool ?? '') ? 'web' : 'context';
}

function groupLabel(key: string): string {
  return key === 'web' ? 'Web research' : 'Gathered context';
}

function summarize(pairs: ToolPair[]): string {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    const action = friendlyAction(pair.call.tool ?? 'tool');
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  return [...counts.entries()].map(([action, count]) => `${count} ${action}`).join(', ');
}

function makeGroup(roundId: string, key: string, pairs: ToolPair[]): ToolGroup {
  return {
    kind: 'tool_group',
    id: `${roundId}:group:${key}:${pairs.map((pair) => pair.call.id).join('|')}`,
    label: groupLabel(key),
    summary: summarize(pairs),
    pairs,
  };
}

/**
 * Collapse runs of adjacent successful read-only context calls into summary
 * groups. Mutations, dispatches, errors, pending calls, diagnostics, and
 * singletons are never grouped — they stay visible.
 */
export function groupToolPairs(roundId: string, pairs: ToolPair[]): ToolListItem[] {
  const result: ToolListItem[] = [];
  let activeKey: string | null = null;
  let active: ToolPair[] = [];

  function flush(): void {
    if (active.length === 0) return;
    if (active.length >= 2 && activeKey) result.push(makeGroup(roundId, activeKey, active));
    else result.push(...active);
    active = [];
    activeKey = null;
  }

  for (const pair of pairs) {
    const key = groupKeyFor(pair);
    if (!key) {
      flush();
      result.push(pair);
      continue;
    }
    if (activeKey !== key) flush();
    activeKey = key;
    active.push(pair);
  }
  flush();
  return result;
}

export function isToolGroup(item: ToolListItem): item is ToolGroup {
  return (item as ToolGroup).kind === 'tool_group';
}
