import type { ChildProcess } from 'node:child_process';
import type { McpServerConfig, SaivageConfig } from '../schemas/saivage-config.js';

export type { McpServerConfig } from '../schemas/saivage-config.js';

export interface McpServerHandle {
  process?: ChildProcess;
  processId?: string;
  abortController?: AbortController;
  streamableHttpSessionId?: string;
}

export function loadMcpServersFromConfig(config: SaivageConfig): Record<string, McpServerConfig> {
  return config.mcpServers ?? {};
}
