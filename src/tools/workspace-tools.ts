import { z } from 'zod';

import { describe, type UnifiedToolDefinition } from './tool-catalog.js';

export const workspaceRuntimeTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'list_project_files', description: 'List files under the Saivage project root. Paths are project-relative; Saivage internal state directories are omitted.', input: z.object({ path: describe(z.string().optional(), 'Project-relative directory to list. Defaults to the project root.'), maxResults: describe(z.number().int().optional(), 'Maximum file paths to return. Defaults to 200; capped at 1000.') }).strict(), roles: ['planner', 'executor', 'reviewer'], workspace: true },
  { name: 'read_project_file', description: 'Read a project file safely. Paths must resolve inside the project root; blocked Saivage credential files cannot be read and secrets are redacted where appropriate.', input: z.object({ path: z.string() }).strict(), roles: ['planner', 'executor', 'reviewer'], workspace: true },
  { name: 'write_project_file', description: 'Create or replace a project file. Paths must resolve inside the project root and may not write Saivage internal state or blocked credential/runtime files.', input: z.object({ path: z.string(), content: z.string() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'wait_for_process', description: 'Wait for a previously-started Saivage process by id. Already-terminal processes return their cached terminal status.', input: z.object({ processId: z.string(), timeoutMs: z.number().int().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'kill_process', description: 'Request termination of a Saivage process by id. Already-terminal processes are returned unchanged.', input: z.object({ processId: z.string(), signal: z.string().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'start_and_wait', description: 'Run a shell command and wait for completion using the durable Saivage process runner.', input: z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
  { name: 'run_project_command', description: 'Run a shell command from the project root or a project-relative working directory. Output is captured through the Saivage process runner.', input: z.object({ command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().optional() }).strict(), roles: ['planner', 'executor'], workspace: true },
] as const;
