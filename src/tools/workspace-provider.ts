import { applyProjectPatch, editProject, globProject, grepProject, readProject, WorkspaceToolInputError, writeProject } from './project-file-tools.js';
import { applyPatchInputSchema, editWorkspaceInputSchema, globWorkspaceInputSchema, grepWorkspaceInputSchema, readWorkspaceInputSchema, writeWorkspaceInputSchema } from '../contracts/builtin-tool-inputs.js';
import { bindToolProvider, defineToolBinder, type ToolBinder, type ToolProvider, type ToolResult } from './invocation.js';
import type { AgentName } from '../schemas/index.js';
import type { CardService } from '../cards/card-api.js';
import type { CardNotification } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import type { ToolContext as AnalystToolContext } from './analyst-tool-types.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';

export interface WorkspaceProviderContext {
  readonly projectRoot: string;
  readonly cardId?: string;
  readonly agentName: AgentName;
  readonly filesystemWrite:boolean;
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
    throwIfPublicationOutcomeUnknown(err);
    if (!isExpectedWorkspaceFailure(err)) throw err;
    return failureFromError(err);
  }
}

const readDescription = 'Read a project:///, record:///, tmp:///, system:///, or read-only work:/// file or directory through scoped URLs. Use work:/// to page through runtime process output and stash files. Text reads return at most 2000 lines, 2000 characters per line, and about 256KB total inline content; files larger than about 10MB are not read inline. Set metadata_only to inspect file size/mtime or visible directory entry counts without reading content.';
const grepDescription = 'Stream-search text files, including files too large for inline read, with a JavaScript regular expression under project:///, record:///, tmp:///, read-only work:///, or system:/// paths. Search retains at most 2000 characters per line and reports content truncation when an overlong suffix was not searched. grep record:///<cardId> searches the latest closed configured records and returns record URLs as path. work:/// content is redacted before return.';
const analystWorkspace = (ctx: AnalystToolContext): WorkspaceProviderContext => ({ projectRoot: ctx.projectRoot, agentName:ctx.actor,filesystemWrite:true,store: ctx.store, notifyCard: ctx.runtime?.notifyCard });

export const workspaceToolBinders: readonly ToolBinder<WorkspaceProviderContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'read', description: readDescription, inputSchema: readWorkspaceInputSchema, executor: (ctx, args) => runWorkspaceTool(() => readProject(ctx, args)) }),
  defineToolBinder({ name: 'write', description: 'Create or replace a project, record, tmp, or system file according to the named agent contract.', inputSchema: writeWorkspaceInputSchema, executor: (ctx, args) => runWorkspaceTool(() => writeProject(ctx, args)) }),
  defineToolBinder({ name: 'edit', description: 'Replace exact text in a project, record, tmp, or system file according to the named agent contract.', inputSchema: editWorkspaceInputSchema, executor: (ctx, args) => runWorkspaceTool(() => editProject(ctx, args)) }),
  defineToolBinder({ name: 'glob', description: 'Search files by glob pattern under a scoped directory, including read-only work:/// process-output and stash directories.', inputSchema: globWorkspaceInputSchema, executor: (ctx, args) => runWorkspaceTool(() => globProject(ctx, args)) }),
  defineToolBinder({ name: 'grep', description: grepDescription, inputSchema: grepWorkspaceInputSchema, executor: (ctx, args) => runWorkspaceTool(() => grepProject(ctx, args)) }),
]);
export const patchToolBinders: readonly ToolBinder<WorkspaceProviderContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'apply_patch', description: 'Apply a text-only unified diff. Patch paths are project-relative only; scoped URL paths such as work:/// are rejected in diff headers.', inputSchema: applyPatchInputSchema, executor: (ctx, args) => runWorkspaceTool(() => applyProjectPatch(ctx, args)) }),
]);
export const analystWorkspaceToolBinders: readonly ToolBinder<AnalystToolContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'read', description: readDescription, inputSchema: readWorkspaceInputSchema, executor: (ctx, args) => runWorkspaceTool(() => readProject(analystWorkspace(ctx), args)) }),
  defineToolBinder({ name: 'write', description: 'Create or replace a project, record, tmp, or system file according to the named agent contract.', inputSchema: writeWorkspaceInputSchema, executor: (ctx, args, signal) => args.path.startsWith('record:///') ? runAuditedAnalystTool(ctx, args, { action: 'record.write', safety_class: 'low', target_kind: 'card', getTargetId: (input) => input.path, lifecycle: 'intervention_ready', mutate: (_prepared, input, mutation) => mutation.services.recordMutations.write(input.path, input.content) }, signal) : runWorkspaceTool(() => writeProject(analystWorkspace(ctx), args)) }),
  defineToolBinder({ name: 'edit', description: 'Replace exact text in a project, record, tmp, or system file according to the named agent contract.', inputSchema: editWorkspaceInputSchema, executor: (ctx, args, signal) => args.path.startsWith('record:///') ? runAuditedAnalystTool(ctx, args, { action: 'record.edit', safety_class: 'low', target_kind: 'card', getTargetId: (input) => input.path, lifecycle: 'intervention_ready', mutate: (_prepared, input, mutation) => mutation.services.recordMutations.edit(input.path, input.old_string, input.new_string, input.replace_all === true) }, signal) : runWorkspaceTool(() => editProject(analystWorkspace(ctx), args)) }),
  defineToolBinder({ name: 'glob', description: 'Search files by glob pattern under a scoped directory, including read-only work:/// process-output and stash directories.', inputSchema: globWorkspaceInputSchema, executor: (ctx, args) => runWorkspaceTool(() => globProject(analystWorkspace(ctx), args)) }),
  defineToolBinder({ name: 'grep', description: grepDescription, inputSchema: grepWorkspaceInputSchema, executor: (ctx, args) => runWorkspaceTool(() => grepProject(analystWorkspace(ctx), args)) }),
]);
export const analystPatchToolBinders: readonly ToolBinder<AnalystToolContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'apply_patch', description: 'Apply a text-only unified diff.', inputSchema: applyPatchInputSchema, executor: (ctx, args) => runWorkspaceTool(() => applyProjectPatch({ projectRoot: ctx.projectRoot,agentName:ctx.actor,filesystemWrite:true }, args)) }),
]);

export const createWorkspaceProvider = (ctx: WorkspaceProviderContext): ToolProvider => bindToolProvider('workspace', workspaceToolBinders, ctx);
export const createPatchProvider = (ctx: WorkspaceProviderContext): ToolProvider => bindToolProvider('patch', patchToolBinders, ctx);
export const createAnalystWorkspaceProvider = (ctx: AnalystToolContext): ToolProvider => bindToolProvider('workspace', analystWorkspaceToolBinders, ctx);
export const createAnalystPatchProvider = (ctx: AnalystToolContext): ToolProvider => bindToolProvider('patch', analystPatchToolBinders, ctx);
