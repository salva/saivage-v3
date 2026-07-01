import { z } from 'zod';

import { describe, type UnifiedToolDefinition } from './tool-catalog.js';
import { projectFileTools } from './project-file-tools.js';

export const workspaceRuntimeTools: readonly UnifiedToolDefinition<string, any>[] = [
  ...projectFileTools,
  { name: 'run_command', description: 'Run a shell command from a scoped working directory. Set wait=false to start a background process.', input: z.object({ command: z.string(), cwd: z.string().optional(), timeout_ms: z.number().int().optional(), inactivity_timeout_ms: z.number().int().optional(), wait: z.boolean().optional() }).strict(), roles: ['executor'], workspace: true },
  { name: 'wait_process', description: 'Wait for an owned background process. timeout_ms=0 performs non-blocking inspection.', input: z.object({ process_id: z.string(), timeout_ms: z.number().int().optional() }).strict(), roles: ['executor'], workspace: true },
  { name: 'kill_process', description: 'Signal an owned background process. Defaults to SIGTERM.', input: z.object({ process_id: z.string(), signal: z.string().optional() }).strict(), roles: ['executor'], workspace: true },
] as const;
