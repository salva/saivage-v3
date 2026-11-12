import type { McpAccessPolicy } from '../schemas/index.js';
import { McpLifecycleError } from './errors.js';

export const MCP_OPERATIONS = [
  'mcp_servers',
  'mcp_tools',
  'mcp_tool_call',
  'mcp_server_control',
  'mcp_server_register',
  'mcp_server_replace',
  'mcp_server_unregister',
  'mcp_catalog_refresh',
  'mcp_server_set_scope',
] as const;
export type McpOperation = (typeof MCP_OPERATIONS)[number];
export type McpCaller = {
  principal: { kind: 'card'; cardId: string } | { kind: 'global' } | { kind: 'operator' };
  operations: readonly McpOperation[];
};
export const MCP_OPERATOR_CALLER: McpCaller = Object.freeze({
  principal: Object.freeze({ kind: 'operator' as const }),
  operations: MCP_OPERATIONS,
});
export const MCP_MANAGEMENT_OPERATIONS: readonly McpOperation[] = [
  'mcp_server_control',
  'mcp_server_replace',
  'mcp_server_unregister',
  'mcp_catalog_refresh',
  'mcp_server_set_scope',
];

/** The injected owner reads one exact committed path, returning only its live prefix. */
export class McpAdmission {
  constructor(private readonly readPath: (cardId: string) => readonly string[]) {}

  requireGrant(caller: McpCaller, operation: McpOperation): void {
    if (!caller.operations.includes(operation)) this.unavailable();
  }
  unavailable(): never {
    throw new McpLifecycleError('MCP server unavailable.', 404);
  }
  destination(caller: McpCaller, policy: McpAccessPolicy): void {
    const path = this.readPath(policy.controllerCardId);
    if (path.at(-1) !== policy.controllerCardId) this.unavailable();
    if (caller.principal.kind === 'card' && !path.includes(caller.principal.cardId))
      this.unavailable();
  }
  exposed(caller: McpCaller, policy: McpAccessPolicy): boolean {
    const anchor = this.readPath(policy.controllerCardId);
    if (anchor.at(-1) !== policy.controllerCardId) return false;
    if (caller.principal.kind !== 'card') return true;
    const id = caller.principal.cardId;
    if (id === policy.controllerCardId) return true;
    if (policy.exposure !== 'subtree') return false;
    const path = this.readPath(id);
    return path.at(-1) === id && path.includes(policy.controllerCardId);
  }
  manages(caller: McpCaller, policy: McpAccessPolicy): boolean {
    const path = this.readPath(policy.controllerCardId);
    return caller.principal.kind !== 'card' || path.includes(caller.principal.cardId);
  }
  liveAnchor(policy: McpAccessPolicy): void {
    if (this.readPath(policy.controllerCardId).at(-1) !== policy.controllerCardId)
      this.unavailable();
  }
}
