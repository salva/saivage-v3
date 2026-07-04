import { z } from 'zod';

import { applyProjectPatch, editProject, globProject, grepProject, readProject, WorkspaceToolInputError, writeProject } from './project-file-tools.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';
import type { AgentRole } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';

export interface WorkspaceProviderContext {
  readonly projectRoot: string;
  readonly cardId?: string;
  readonly agentRole: AgentRole;
  readonly store?: Pick<CardStore, 'read'>;
}

function failureFromError(err: unknown): ToolResult {
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

function isExpectedWorkspaceFailure(err: unknown): boolean {
  if (err instanceof WorkspaceToolInputError) return true;
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'EACCES' || code === 'EPERM';
}

async function runWorkspaceTool(action: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { success: true, data: await action() };
  } catch (err) {
    if (!isExpectedWorkspaceFailure(err)) throw err;
    return failureFromError(err);
  }
}

const readSchema = z.object({
  path: z.string(),
  offset: z.number().int().optional(),
  limit: z.number().int().optional(),
  read_mode: z.enum(['auto', 'text', 'multimodal']).optional(),
  metadata_only: z.boolean().optional(),
}).strict();

const writeSchema = z.object({ path: z.string(), content: z.string() }).strict();

const globSchema = z.object({
  directory: z.string(),
  pattern: z.string(),
  max_results: z.number().int().optional(),
}).strict();

const grepSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  include: z.string().optional(),
  max_results: z.number().int().optional(),
}).strict();

const editSchema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
}).strict();

const applyPatchSchema = z.object({ patch: z.string() }).strict();

export function createWorkspaceProvider(ctx: WorkspaceProviderContext): ToolProvider {
  return {
    providerName: 'workspace',
    tools: [
      defineTool({ name: 'read', description: 'Read a project, record, tmp, or system file or directory through scoped URLs.', inputSchema: readSchema, executor: (args) => runWorkspaceTool(() => readProject(ctx, args)) }),
      defineTool({ name: 'write', description: 'Create or replace a project, record, tmp, or system file according to role policy.', inputSchema: writeSchema, executor: (args) => runWorkspaceTool(() => writeProject(ctx, args)) }),
      defineTool({ name: 'edit', description: 'Replace exact text in a project, record, tmp, or system file according to role policy.', inputSchema: editSchema, executor: (args) => runWorkspaceTool(() => editProject(ctx, args)) }),
      defineTool({ name: 'glob', description: 'Search files by glob pattern under a scoped directory.', inputSchema: globSchema, executor: (args) => runWorkspaceTool(() => globProject(ctx, args)) }),
      defineTool({ name: 'grep', description: 'Search text files with a JavaScript regular expression.', inputSchema: grepSchema, executor: (args) => runWorkspaceTool(() => grepProject(ctx, args)) }),
    ],
  };
}

export function createPatchProvider(ctx: WorkspaceProviderContext): ToolProvider {
  return {
    providerName: 'patch',
    tools: [
      defineTool({ name: 'apply_patch', description: 'Apply a text-only unified diff after scoped path validation.', inputSchema: applyPatchSchema, executor: (args) => runWorkspaceTool(() => applyProjectPatch(ctx, args)) }),
    ],
  };
}
