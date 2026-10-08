import type { InlinePart } from './tool-presenters';
import type { TimelineRow } from './agent-timeline';
import { presentToolCall, presentToolResult } from './tool-presenters';
import { getToolPresenter } from './tool-presenters/presenters';
import type { SemanticSection, ToolResultPresentation } from './tool-presenters/types';

export function isKnownTool(name: string): boolean {
  return getToolPresenter(name) !== undefined;
}
function friendlyAction(name: string): string {
  return getToolPresenter(name)?.action ?? name;
}
export function inlinePartsText(parts: readonly InlinePart[]): string {
  return parts
    .map((part) =>
      part.kind === 'text'
        ? part.text
        : part.kind === 'file'
          ? (part.label ?? part.path)
          : part.kind === 'entry' || part.kind === 'session'
            ? part.label
            : (part.fallbackLabel ?? part.id),
    )
    .join('')
    .trim();
}
export interface ToolDisplayModel {
  action: string;
  toolName: string;
  target: InlinePart[];
  links: InlinePart[];
  status: InlinePart[];
  statusTone: ToolResultPresentation['status'];
  requestSections: SemanticSection[];
  resultSections: SemanticSection[];
}
export function buildToolDisplay(row: TimelineRow): ToolDisplayModel {
  const isCall = row.entry.kind === 'tool_call';
  const call = isCall
    ? presentToolCall(row.entry.content)
    : row.mate
      ? presentToolCall(row.mate.content)
      : null;
  const toolName = call?.name ?? row.entry.tool ?? 'tool';
  const resultEntry = isCall ? row.mate : row.entry;
  const result = resultEntry ? presentToolResult(resultEntry.content, { tool: toolName }) : null;
  const summary = result ? inlinePartsText(result.headline) : '';
  const callParts = call
    ? call.headline
    : [...(result?.target ?? []), { kind: 'text' as const, text: 'Requested context unavailable' }];
  return {
    action: isCall ? friendlyAction(toolName) : `Result · ${friendlyAction(toolName)}`,
    toolName,
    target: callParts.map((part) => ({ kind: 'text', text: inlinePartsText([part]) })),
    links: callParts.flatMap((part): InlinePart[] =>
      part.kind === 'file'
        ? [{ ...part, label: 'Open file' }]
        : part.kind === 'card'
          ? [{ ...part, fallbackLabel: 'Open card' }]
          : part.kind === 'session'
            ? [{ ...part, label: 'Open session' }]
            : part.kind === 'entry'
              ? [part]
              : [],
    ),
    status: result
      ? [{ kind: 'text', text: `${result.outcome}${summary ? ` · ${summary}` : ''}` }]
      : row.mate
        ? []
        : [{ kind: 'text', text: 'No result recorded' }],
    statusTone: result?.status ?? 'neutral',
    requestSections: call?.sections ?? [],
    resultSections: result?.sections ?? [],
  };
}
