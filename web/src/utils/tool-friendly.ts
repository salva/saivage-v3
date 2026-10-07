import type { InlinePart } from './tool-presenters';
import type { TimelineRow } from './agent-timeline';
import { presentToolCall, presentToolResult } from './tool-presenters';
import { getToolPresenter } from './tool-presenters/presenters';
import type { SemanticSection, ToolTone } from './tool-presenters/types';
export type { ToolTone } from './tool-presenters/types';

export function isKnownTool(name: string): boolean { return getToolPresenter(name) !== undefined; }
function friendlyAction(name: string): string { return getToolPresenter(name)?.action ?? name; }
export function inlinePartsText(parts: readonly InlinePart[]): string {
  return parts.map((part) => part.kind === 'text' ? part.text : part.kind === 'file' ? part.label ?? part.path : part.kind === 'entry' || part.kind === 'session' ? part.label : part.fallbackLabel ?? part.id).join('').trim();
}
export interface ToolDisplayModel {
  action: string;
  toolName: string;
  target: InlinePart[];
  links: InlinePart[];
  status: InlinePart[];
  statusTone: ToolTone;
  known: boolean;
  sections: SemanticSection[];
}
export function buildToolDisplay(row: TimelineRow): ToolDisplayModel {
  const isCall = row.entry.kind === 'tool_call';
  const call = isCall ? presentToolCall(row.entry.content) : row.mate ? presentToolCall(row.mate.content) : null;
  const toolName = call?.name ?? row.entry.tool ?? 'tool';
  const result = isCall ? null : presentToolResult(row.entry.content, { tool: toolName });
  const summary = result ? inlinePartsText(result.headline) : '';
  const callParts = call ? call.headline : [...(result?.target ?? []), { kind: 'text' as const, text: 'Requested context unavailable' }];
  return {
    action: isCall ? `Requested ${friendlyAction(toolName)}` : 'Recorded result', toolName,
    target: callParts.filter((p) => p.kind === 'text'),
    links: [...callParts.filter((p) => p.kind !== 'text'), ...(isCall && row.mate ? [{ kind: 'entry' as const, id: row.mate.id, label: 'Result recorded below' }] : [])],
    status: result ? [{ kind: 'text', text: `${result.outcome}${summary ? ` · ${summary}` : ''}` }] : row.mate ? [] : [{ kind: 'text', text: 'No result recorded' }],
    statusTone: result?.status ?? 'neutral', known: isKnownTool(toolName),
    sections: isCall ? call!.sections : result!.sections,
  };
}
