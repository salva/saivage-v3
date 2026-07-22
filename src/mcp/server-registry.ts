import type { ChildProcess } from 'node:child_process';
import type { McpServerConfig, SaivageConfig } from '../agents/config-api.js';

export type { McpServerConfig } from '../agents/config-api.js';

export interface McpServerHandle {
  process?: ChildProcess;
  processId?: string;
  abortController?: AbortController;
  streamableHttpSessionId?: string;
}

export function loadMcpServersFromConfig(config: SaivageConfig): Record<string, McpServerConfig> {
  return config.mcpServers ?? {};
}
