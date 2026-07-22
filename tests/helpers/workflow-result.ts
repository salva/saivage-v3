import type { WorkflowResult } from '../../src/schemas/lifecycle.js';

export function workflowResult(terminal: WorkflowResult['terminal'], summary: string, options: Partial<Pick<WorkflowResult, 'agent_name' | 'node_id' | 'outcome' | 'records'>> = {}): WorkflowResult {
  return {
    kind: 'workflow-result',
    terminal,
    agent_name: options.agent_name ?? (terminal === 'DONE' ? 'executor' : 'executor'),
    node_id: options.node_id ?? 'execute',
    outcome: options.outcome ?? terminal.toLowerCase(),
    summary,
    records: options.records ?? [],
  };
}

export function runtimeFailure(summary: string) { return { kind: 'runtime-failure' as const, summary }; }
