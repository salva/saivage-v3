/** Narrow the known fixture selection; never manufacture an agent for an action. */
export function agentExecution<T extends { execution: { kind: 'agent' } | { kind: 'action' } }>(
  node: T,
): Extract<T['execution'], { kind: 'agent' }> {
  if (node.execution.kind !== 'agent') throw new Error('Expected an agent fixture.');
  return node.execution as Extract<T['execution'], { kind: 'agent' }>;
}

/** Tests inspecting direct fixture edges must not silently ignore case routes. */
export function directEdge<T extends { target: unknown } | { cases: unknown }>(
  edge: T,
): Extract<T, { target: unknown }> {
  if (!('target' in edge)) throw new Error('Expected a direct fixture edge.');
  return edge as Extract<T, { target: unknown }>;
}
