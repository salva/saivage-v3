import type { EventLog } from '../observability/index.js';

export interface McpInvocationStat { total: number; success: number; error: number; lastInvokedAt?: string }

export class McpInvocationStatsRecorder {
  private readonly stats = new Map<string, McpInvocationStat>();

  constructor(private readonly eventLogger: EventLog) {}

  record(serverName: string, toolName: string, success: boolean): void {
    const key = `${serverName}:${toolName}`;
    const current = this.stats.get(key) ?? { total: 0, success: 0, error: 0 };
    current.total++;
    if (success) current.success++;
    else current.error++;
    current.lastInvokedAt = new Date().toISOString();
    this.stats.set(key, current);
  }

  publish(server: string, tool: string, success: boolean, durationMs: number, operationError?: unknown): void {
    this.eventLogger.appendEventPrepared(() => ({
      kind: 'mcp_tool_invocation',
      server,
      tool,
      success,
      duration_ms: durationMs,
      ...(operationError === undefined ? {} : { error: operationError instanceof Error ? operationError.message : String(operationError) }),
    }));
  }

  snapshot(): Record<string, McpInvocationStat> {
    const out: Record<string, McpInvocationStat> = {};
    for (const [key, val] of this.stats) out[key] = { ...val };
    return out;
  }
}
