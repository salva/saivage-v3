import type { CardWorkflowPosition } from '../api/types';

const livenessPhrases: ReadonlyMap<string, string> = new Map([
  ['active·busy', 'Active — working now'],
  ['inactive·idle', 'Idle — no current work'],
]);

export function livenessPhrase(status: string, activity: string): string {
  return livenessPhrases.get(`${status}·${activity}`) ?? `${status} · ${activity}`;
}

interface CompiledWorkflowNode {
  node_id: string;
  agent_name: string;
}

interface CompiledWorkflowGraphLike {
  nodes?: readonly CompiledWorkflowNode[];
}

export function positionGloss(position: CardWorkflowPosition, graph: CompiledWorkflowGraphLike | null | undefined): string | null {
  if (!graph?.nodes) return null;
  if (position.kind === 'node') {
    const node = graph.nodes.find((candidate) => candidate.node_id === position.nodeId);
    if (!node) return null;
    return `${node.agent_name}'s step in this workflow.`;
  }
  if (position.kind === 'terminal') {
    return 'Terminal positions are configured end states, not lifecycle status.';
  }
  return null;
}

interface ResultLike {
  summary?: string | null;
  [key: string]: unknown;
}

export const RESULT_ONE_LINER_MAX = 120;

export function resultOneLiner(result: ResultLike | null | undefined): string | null {
  if (!result) return null;
  const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
  if (summary) {
    return summary.length > RESULT_ONE_LINER_MAX ? `${summary.slice(0, RESULT_ONE_LINER_MAX).trimEnd()}…` : summary;
  }
  const keys = Object.keys(result).filter((key) => key !== 'summary').slice(0, 3);
  return keys.length > 0 ? keys.join(', ') : null;
}

export function scopeWord(sessionScope: string): string {
  if (sessionScope === 'card') return 'Card session';
  if (sessionScope === 'global') return 'Global session';
  return sessionScope;
}

export function compactUuid(value: string): string {
  const groups = value.split('-');
  if (groups.length < 4) return value;
  return `${groups[0]}…`;
}
