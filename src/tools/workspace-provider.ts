import { z } from 'zod';

import { applyProjectPatch, editProject, globProject, grepProject, readProject, WorkspaceToolInputError, writeProject } from './project-file-tools.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';
import type { AgentRole } from '../schemas/index.js';
import type { CardService } from '../cards/card-api.js';
import type { CardNotification } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import type { ToolContext as AnalystToolContext } from './analyst-tool-types.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { commitEditBrief, commitWriteBrief, recheckEditBrief, recheckWriteBrief } from '../application/analyst-mutation-operations.js';

export interface WorkspaceProviderContext {
  readonly projectRoot: string;
  readonly cardId?: string;
  readonly agentRole: AgentRole;
  readonly store?: Pick<CardService, 'read' | 'getAncestors' | 'recordReader' | 'readRecord' | 'openRecord' | 'editRecord' | 'closeRecord' | 'discardRecord'>;
  readonly notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;
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
      defineTool({ name: 'read', description: 'Read a project:///, record:///, tmp:///, system:///, or read-only work:/// file or directory through scoped URLs. Use work:/// to page through runtime process output and stash files. Text reads return at most 2000 lines, 2000 characters per line, and about 256KB total inline content; files larger than about 10MB are not read inline. Set metadata_only to inspect file size/mtime or visible directory entry counts without reading content.', inputSchema: readSchema, executor: (args) => runWorkspaceTool(() => readProject(ctx, args)) }),
      defineTool({ name: 'write', description: 'Create or replace a project, record, tmp, or system file according to role policy.', inputSchema: writeSchema, executor: (args) => runWorkspaceTool(() => writeProject(ctx, args)) }),
      defineTool({ name: 'edit', description: 'Replace exact text in a project, record, tmp, or system file according to role policy.', inputSchema: editSchema, executor: (args) => runWorkspaceTool(() => editProject(ctx, args)) }),
      defineTool({ name: 'glob', description: 'Search files by glob pattern under a scoped directory, including read-only work:/// process-output and stash directories.', inputSchema: globSchema, executor: (args) => runWorkspaceTool(() => globProject(ctx, args)) }),
      defineTool({ name: 'grep', description: 'Stream-search text files, including files too large for inline read, with a JavaScript regular expression under project:///, record:///, tmp:///, read-only work:///, or system:/// paths. Search retains at most 2000 characters per line and reports content truncation when an overlong suffix was not searched. grep record:///<cardId> searches the latest closed versions of exposed record slots and returns record URLs as path. work:/// content is redacted before return.', inputSchema: grepSchema, executor: (args) => runWorkspaceTool(() => grepProject(ctx, args)) }),
    ],
  };
}

export function createPatchProvider(ctx: WorkspaceProviderContext): ToolProvider {
  return {
    providerName: 'patch',
    tools: [
      defineTool({ name: 'apply_patch', description: 'Apply a text-only unified diff. Patch paths are project-relative only; scoped URL paths such as work:/// are rejected in diff headers.', inputSchema: applyPatchSchema, executor: (args) => runWorkspaceTool(() => applyProjectPatch(ctx, args)) }),
    ],
  };
}

export function createAnalystWorkspaceProvider(ctx: AnalystToolContext): ToolProvider {
  const workspace: WorkspaceProviderContext = { projectRoot: ctx.projectRoot, agentRole: 'analyst', store: ctx.store, notifyCard: ctx.runtime?.notifyCard };
  return {
    providerName: 'workspace',
    tools: [
      defineTool({ name: 'read', description: 'Read a project:///, record:///, tmp:///, system:///, or read-only work:/// file or directory through scoped URLs. Use work:/// to page through runtime process output and stash files. Text reads return at most 2000 lines, 2000 characters per line, and about 256KB total inline content; files larger than about 10MB are not read inline. Set metadata_only to inspect file size/mtime or visible directory entry counts without reading content.', inputSchema: readSchema, executor: (args) => runWorkspaceTool(() => readProject(workspace, args)) }),
      defineTool({ name: 'write', description: 'Create or replace a project, record, tmp, or system file according to role policy.', inputSchema: writeSchema, executor: (args, signal) => args.path.startsWith('record:///')
        ? runAuditedAnalystTool(ctx, args, { action: 'record.write', safety_class: 'low', target_kind: 'card', getTargetId: (input) => input.path, lifecycle: 'intervention_ready', recheck: recheckWriteBrief, commit: commitWriteBrief }, signal)
        : runWorkspaceTool(() => writeProject(workspace, args)) }),
      defineTool({ name: 'edit', description: 'Replace exact text in a project, record, tmp, or system file according to role policy.', inputSchema: editSchema, executor: (args, signal) => args.path.startsWith('record:///')
        ? runAuditedAnalystTool(ctx, args, { action: 'record.edit', safety_class: 'low', target_kind: 'card', getTargetId: (input) => input.path, lifecycle: 'intervention_ready', recheck: recheckEditBrief, commit: commitEditBrief }, signal)
        : runWorkspaceTool(() => editProject(workspace, args)) }),
      defineTool({ name: 'glob', description: 'Search files by glob pattern under a scoped directory, including read-only work:/// process-output and stash directories.', inputSchema: globSchema, executor: (args) => runWorkspaceTool(() => globProject(workspace, args)) }),
      defineTool({ name: 'grep', description: 'Stream-search text files, including files too large for inline read, with a JavaScript regular expression under project:///, record:///, tmp:///, read-only work:///, or system:/// paths. Search retains at most 2000 characters per line and reports content truncation when an overlong suffix was not searched. grep record:///<cardId> searches the latest closed versions of exposed record slots and returns record URLs as path. work:/// content is redacted before return.', inputSchema: grepSchema, executor: (args) => runWorkspaceTool(() => grepProject(workspace, args)) }),
    ],
  };
}

export function createAnalystPatchProvider(ctx: AnalystToolContext): ToolProvider {
  return { providerName: 'patch', tools: [defineTool({ name: 'apply_patch', description: 'Apply a text-only unified diff.', inputSchema: applyPatchSchema, executor: (args) => runWorkspaceTool(() => applyProjectPatch({ projectRoot: ctx.projectRoot, agentRole: 'analyst' }, args)) })] };
}
