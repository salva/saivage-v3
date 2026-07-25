import type { McpServerConfig, McpServerHandle } from './server-registry.js';
import type { McpServerStatus as RuntimeMcpServerStatus, McpToolDefinition } from './protocol.js';
import type { McpInvocationStat } from './invocation-stats.js';

export interface InternalMcpToolsReadModel {
  servers: Array<{
    name: string;
    transport: RuntimeMcpServerStatus['transport'];
    status: RuntimeMcpServerStatus['status'];
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
}): RuntimeMcpServerStatus {
  const { name, config: cfg, handle, override, startedAt, tools } = input;
  if (cfg.disabled) return { name, transport: cfg.transport, status: 'stopped' };
  if (override?.status === 'error') return { name, transport: cfg.transport, status: 'error', error: override.error, startedAt, tools_count: tools?.length ?? 0 };
  if (override?.status === 'stopped') return { name, transport: cfg.transport, status: 'stopped', startedAt, tools_count: 0 };
  if (!handle) return { name, transport: cfg.transport, status: 'stopped', startedAt, tools_count: 0 };
  if (cfg.transport === 'stdio' && handle.process) {
    const proc = handle.process;
    if (proc.killed || proc.exitCode !== null) return { name, transport: cfg.transport, status: 'error', pid: proc.pid ?? undefined, error: proc.killed ? 'Process was killed' : `Process exited with code ${proc.exitCode}`, startedAt, tools_count: tools?.length ?? 0 };
    return { name, transport: cfg.transport, status: 'running', pid: proc.pid ?? undefined, startedAt, tools_count: tools?.length ?? 0 };
  }
  if (cfg.transport === 'streamable-http') {
    if (handle.abortController?.signal.aborted) return { name, transport: cfg.transport, status: 'stopped', startedAt, tools_count: tools?.length ?? 0 };
    return { name, transport: cfg.transport, status: 'running', startedAt, tools_count: tools?.length ?? 0 };
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
      const statsKey = `${status.name}:${td.name}`;
      const stats = input.invocationStats[statsKey] ?? { total: 0, success: 0, error: 0 };
      return { ...td, stats };
    });
    return { name: status.name, transport: status.transport, status: status.status, toolCount: toolDefs.length, tools: toolList };
  });
  return { servers: serverDetails };
}
