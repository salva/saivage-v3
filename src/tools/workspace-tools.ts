import { z } from 'zod';

import { describe, type UnifiedToolDefinition } from './tool-catalog.js';
import { projectFileTools } from './project-file-tools.js';

export const workspaceRuntimeTools: readonly UnifiedToolDefinition<string, any>[] = [
  ...projectFileTools,
  { name: 'wait_for_process', description: 'Wait for a previously-started Saivage process by id. Already-terminal processes return their cached terminal status and registerable logFiles paths.', input: z.object({ processId: z.string(), timeoutMs: z.number().int().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'kill_process', description: 'Request termination of a Saivage process by id. Already-terminal processes are returned unchanged with registerable logFiles paths.', input: z.object({ processId: z.string(), signal: z.string().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'start_and_wait', description: 'Run a shell command and wait for completion using the durable Saivage process runner. Returns registerable logFiles paths for command evidence.', input: z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'run_project_command', description: 'Run a shell command from the project root or a project-relative working directory. Output is captured through the Saivage process runner and returned with registerable logFiles paths.', input: z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
] as const;
