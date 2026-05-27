import type { ChildProcess } from 'node:child_process';
import { loadConfig, type SaivageConfig } from '../agents/config-api.js';
import type { McpTransport } from './protocol.js';

export interface McpServerHandle {
  process?: ChildProcess;
  abortController?: AbortController;
  streamableHttpSessionId?: string;
}

export interface McpServerConfig {
  transport: McpTransport;
  disabled: boolean;
  autostart: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export function normalizeMcpServers(config: SaivageConfig): Record<string, McpServerConfig> {
  const raw = config.mcpServers ?? {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    out[name] = {
      transport: entry.transport,
      disabled: entry.disabled ?? false,
      autostart: entry.autostart ?? true,
      command: entry.command,
      args: entry.args,
      env: entry.env,
      url: entry.url,
    };
  }
  return out;
}

export function loadMcpServersFromConfig(projectRoot: string): Record<string, McpServerConfig> {
  const { config } = loadConfig(projectRoot);
  return normalizeMcpServers(config);
}
