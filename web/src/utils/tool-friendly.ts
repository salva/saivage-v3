import type { InlinePart } from './tool-presenters';
import type { ToolPair, ToolGroup, ToolListItem } from './agent-timeline/types';
import { presentToolCall, presentToolResult } from './tool-presenters';
import { getToolPresenter } from './tool-presenters/presenters';

export type ToolTone = 'neutral' | 'ok' | 'warn' | 'error' | 'pending';

export function isKnownTool(name: string): boolean {
  return getToolPresenter(name) !== undefined;
}

export function friendlyAction(name: string): string {
  const descriptor = getToolPresenter(name);
  if (descriptor) return descriptor.action;
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
  const resultPres = result ? presentToolResult(result.content, { tool: result.tool }) : null;
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
  } else {
    const resultParts = [...(resultPres?.headline ?? []), ...(resultPres?.detail ?? [])];
    const text = inlineText(resultParts);
    if (text) {
      statusParts = resultParts.filter((part) => !isInteractive(part));
      statusTone = resultPres?.status === 'error' ? 'error' : 'ok';
    }
    const linkExtras = resultParts.filter(isInteractive);
    if (linkExtras.length) links.push(...linkExtras);
  }

  return { action, toolName: callPres.name, target, links, status: statusParts, statusTone, known };
}

export function isGroupable(pair: ToolPair): boolean {
  if (pair.status !== 'ok') return false;
  const name = pair.call.tool ?? '';
  return getToolPresenter(name)?.group !== undefined;
}

function groupKeyFor(pair: ToolPair): string | null {
  if (!isGroupable(pair)) return null;
  return getToolPresenter(pair.call.tool ?? '')?.group ?? null;
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
