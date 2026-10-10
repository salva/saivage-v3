import type { ChildProcess } from 'node:child_process';

export type { McpServerConfig } from '../schemas/index.js';

export interface McpServerHandle {
  process?: ChildProcess;
  processId?: string;
  abortController?: AbortController;
  streamableHttpSessionId?: string;
}
