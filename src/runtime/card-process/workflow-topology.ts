import type { WorkflowPresentation } from '../../contracts/index.js';
import type {
  CardProcessEntry,
  CompiledCardTypeWorkflow,
  CompiledNodeContract,
  CompiledProcessTransition,
} from './card-process-config.js';

export function workflowEntryTarget(
  workflow: CompiledCardTypeWorkflow,
  entry: CardProcessEntry,
): string {
  const route = workflow.states.get(`entry:${entry}`)?.on.get('entry:route');
  const target = route && workflow.states.get(route.targetStateId);
  if (route?.semantic.kind !== 'entry-route' || target?.kind !== 'node')
    throw new Error(`Compiled workflow '${workflow.cardType}' has invalid entry '${entry}'.`);
  return target.nodeId;
}

export function workflowEdge(
  workflow: CompiledCardTypeWorkflow,
  node: CompiledNodeContract,
  route: CompiledProcessTransition,
): WorkflowPresentation['edges'][number] {
  const target = workflow.states.get(route.targetStateId);
  if (!target || (target.kind !== 'node' && target.kind !== 'terminal'))
    throw new Error('Invalid compiled workflow edge target.');
  let outcome: string;
  let condition: 'default' | 'pending_notifications' = 'default';
  switch (route.semantic.kind) {
    case 'configured-outcome':
      outcome = route.semantic.outcome;
      break;
    case 'configured-pending-notifications':
      if (target.kind !== 'node') throw new Error('Invalid pending-notifications target.');
      outcome = route.semantic.outcome;
      condition = 'pending_notifications';
      break;
    case 'notification-interrupt':
      if (target.kind !== 'node') throw new Error('Invalid interruption target.');
      outcome = 'notification:interrupt';
      break;
    case 'runtime-terminal':
      if (target.kind !== 'terminal') throw new Error('Invalid runtime terminal target.');
      outcome = route.semantic.cause === 'failed' ? 'execution:failed' : 'execution:blocked';
      break;
    default:
      throw new Error('Invalid compiled workflow node transition.');
  }
  return {
    source_node_id: node.nodeId,
    outcome,
    condition,
    target:
      target.kind === 'node'
        ? { kind: 'node', node_id: target.nodeId }
        : { kind: 'terminal', terminal: target.terminal },
  };
}
