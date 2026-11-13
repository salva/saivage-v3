import type { McpServerConfig, McpServerHandle } from './server-registry.js';
import type { McpServerStatus as RuntimeMcpServerStatus, McpToolDefinition } from './protocol.js';
import { mcpInvocationStatsKey, type McpInvocationStat } from './invocation-stats.js';

export interface InternalMcpToolsReadModel {
  servers: Array<{
    name: string;
    transport: RuntimeMcpServerStatus['transport'];
    status: RuntimeMcpServerStatus['status'];
    bindingId: string | null;
    definitionSource: RuntimeMcpServerStatus['definitionSource'];
    policy: RuntimeMcpServerStatus['policy'];
    availableActions: RuntimeMcpServerStatus['availableActions'];
    ready: boolean;
    containment: RuntimeMcpServerStatus['containment'];
    failureReason: RuntimeMcpServerStatus['failureReason'];
    containmentBoundary: RuntimeMcpServerStatus['containmentBoundary'];
    processId: string | null;
    toolCount: number;
    tools: Array<McpToolDefinition & { stats: McpInvocationStat }>;
  }>;
}

export function buildMcpServerStatus(input: {
  name: string;
  config: McpServerConfig;
  handle?: McpServerHandle;
  override?: { status: RuntimeMcpServerStatus['status']; error?: string };
  startedAt?: string;
  tools?: McpToolDefinition[];
  ready: boolean;
  starting: boolean;
}): Pick<
  RuntimeMcpServerStatus,
  'name' | 'transport' | 'status' | 'error' | 'startedAt' | 'tools_count' | 'pid'
> {
  const { name, config: cfg, handle, override, startedAt, tools } = input;
  if (override?.status === 'stopping')
    return { name, transport: cfg.transport, status: 'stopping', startedAt, tools_count: 0 };
  if (cfg.disabled) return { name, transport: cfg.transport, status: 'stopped' };
  if (override?.status === 'error')
    return {
      name,
      transport: cfg.transport,
      status: 'error',
      error: override.error,
      startedAt,
      tools_count: tools?.length ?? 0,
    };
  if (override?.status === 'stopped')
    return { name, transport: cfg.transport, status: 'stopped', startedAt, tools_count: 0 };
  if (!handle)
    return {
      name,
      transport: cfg.transport,
      status: input.starting ? 'starting' : 'stopped',
      startedAt,
      tools_count: 0,
    };
  if (cfg.transport === 'stdio' && handle.process) {
    const proc = handle.process;
    if (proc.killed || proc.exitCode !== null)
      return {
        name,
        transport: cfg.transport,
        status: 'error',
        pid: proc.pid ?? undefined,
        error: proc.killed ? 'Process was killed' : `Process exited with code ${proc.exitCode}`,
        startedAt,
        tools_count: tools?.length ?? 0,
      };
    return {
      name,
      transport: cfg.transport,
      status: input.ready ? 'running' : 'starting',
      pid: proc.pid ?? undefined,
      startedAt,
      tools_count: tools?.length ?? 0,
    };
  }
  if (cfg.transport === 'streamable-http') {
    if (handle.abortController?.signal.aborted)
      return {
        name,
        transport: cfg.transport,
        status: 'stopped',
        startedAt,
        tools_count: tools?.length ?? 0,
      };
    return {
      name,
      transport: cfg.transport,
      status: input.ready ? 'running' : 'starting',
      startedAt,
      tools_count: tools?.length ?? 0,
    };
  }
  return { name, transport: cfg.transport, status: 'stopped' };
}

export function buildMcpToolsReadModel(input: {
  statuses: RuntimeMcpServerStatus[];
  getServerTools: (name: string) => McpToolDefinition[] | undefined;
  invocationStats: Record<string, McpInvocationStat>;
}): InternalMcpToolsReadModel {
  const serverDetails = input.statuses.map((status) => {
    const toolDefs = input.getServerTools(status.name) ?? [];
    const toolList = toolDefs.map((td) => {
      const statsKey = mcpInvocationStatsKey(status.name, td.name);
      const stats = input.invocationStats[statsKey] ?? { total: 0, success: 0, error: 0 };
      return { ...td, stats };
    });
    return {
      name: status.name,
      transport: status.transport,
      status: status.status,
      bindingId: status.bindingId,
      definitionSource: status.definitionSource,
      policy: status.policy,
      availableActions: status.availableActions,
      ready: status.ready,
      containment: status.containment,
      failureReason: status.failureReason,
      containmentBoundary: status.containmentBoundary,
      processId: status.processId,
      toolCount: toolDefs.length,
      tools: toolList,
    };
  });
  return { servers: serverDetails };
}
