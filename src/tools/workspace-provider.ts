import { applyProjectPatch, editProject, globProject, grepProject, readProject, WorkspaceToolInputError, writeProject } from './project-file-tools.js';
import { applyPatchInputSchema, editWorkspaceInputSchema, globWorkspaceInputSchema, grepWorkspaceInputSchema, readWorkspaceInputSchema, writeWorkspaceInputSchema } from '../contracts/builtin-tool-inputs.js';
import { defineToolBinder, executeToolAction, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE, type ToolBinder, type ToolResult } from './invocation.js';
import { boundedToolError } from './response-packer.js';
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
  readonly store?: CardService;
  readonly notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;
  readonly onRecordWritten?: (name: string) => void;
}

function failureFromError(err: unknown): ToolResult {
  return { success: false, error: boundedToolError(err instanceof Error ? err.message : String(err)) };
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

const readDescription = 'Read a project:///, record:///, tmp:///, system:///, or read-only work:/// file or directory through scoped URLs with one exact byte-bounded response envelope. Text files and record documents return UTF-8 TextSlice pages at a stateless {byte_offset} position; directories and record:/// listings return byte-packed collection pages at a stateless {item_index,item_byte_offset} position; pass the emitted next position to continue. work:/// content is redacted before slicing. metadata_only returns bounded scalars plus the sliced path text. Files larger than about 10MB are refused rather than read inline.';
const grepDescription = 'Stream-search text files, including files too large for inline read, with a JavaScript regular expression under project:///, record:///, tmp:///, read-only work:///, or system:/// paths. Search retains at most 2000 characters per line and reports content truncation when an overlong suffix was not searched. grep record:///<cardId> searches effective current configured records and returns record URLs as path. work:/// content is redacted before return.';
const analystWorkspace = (ctx: AnalystToolContext): WorkspaceProviderContext => ({ projectRoot: ctx.projectRoot, agentName:ctx.actor,filesystemWrite:true,store: ctx.store, notifyCard: ctx.runtime.notifyCard });

const observational = (action: () => Promise<ToolResult>) => executeToolAction('observational_query', action);
const operational = (action: () => Promise<ToolResult>) => executeToolAction('none', action);

export const workspaceToolBinders: readonly ToolBinder<WorkspaceProviderContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'read', description: readDescription, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => readWorkspaceInputSchema, executor: (ctx, args) => observational(() => runWorkspaceTool(() => readProject(ctx, args))) }),
  defineToolBinder({ name: 'write', description: 'Create or replace a project, record, tmp, or system file according to the named agent contract.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => writeWorkspaceInputSchema, executor: (ctx, args) => operational(() => runWorkspaceTool(() => writeProject(ctx, args))) }),
  defineToolBinder({ name: 'edit', description: 'Replace exact text in a project, record, tmp, or system file according to the named agent contract.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => editWorkspaceInputSchema, executor: (ctx, args) => operational(() => runWorkspaceTool(() => editProject(ctx, args))) }),
  defineToolBinder({ name: 'glob', description: 'Search files by glob pattern under a scoped directory, including read-only work:/// process-output and stash directories.', resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => globWorkspaceInputSchema, executor: (ctx, args) => observational(() => runWorkspaceTool(() => globProject(ctx, args))) }),
  defineToolBinder({ name: 'grep', description: grepDescription, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => grepWorkspaceInputSchema, executor: (ctx, args) => observational(() => runWorkspaceTool(() => grepProject(ctx, args))) }),
]);
export const patchToolBinders: readonly ToolBinder<WorkspaceProviderContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'apply_patch', description: 'Apply a text-only unified diff. Patch paths are project-relative only; scoped URL paths such as work:/// are rejected in diff headers.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => applyPatchInputSchema, executor: (ctx, args) => operational(() => runWorkspaceTool(() => applyProjectPatch(ctx, args))) }),
]);
export const analystWorkspaceToolBinders: readonly ToolBinder<AnalystToolContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'read', description: readDescription, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => readWorkspaceInputSchema, executor: (ctx, args) => observational(() => runWorkspaceTool(() => readProject(analystWorkspace(ctx), args))) }),
  defineToolBinder({ name: 'write', description: 'Create or replace a project, record, tmp, or system file according to the named agent contract.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => writeWorkspaceInputSchema, executor: (ctx, args, signal) => args.path.startsWith('record:///') ? runAuditedAnalystTool(ctx, args, { action: 'record.write', safety_class: 'low', target_kind: 'card', getTargetId: (input) => input.path, lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' }, mutate: (_prepared, input, mutation) => mutation.services.recordMutations.write(input.path, input.content) }, signal) : operational(() => runWorkspaceTool(() => writeProject(analystWorkspace(ctx), args))) }),
  defineToolBinder({ name: 'edit', description: 'Replace exact text in a project, record, tmp, or system file according to the named agent contract.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => editWorkspaceInputSchema, executor: (ctx, args, signal) => args.path.startsWith('record:///') ? runAuditedAnalystTool(ctx, args, { action: 'record.edit', safety_class: 'low', target_kind: 'card', getTargetId: (input) => input.path, lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' }, mutate: (_prepared, input, mutation) => mutation.services.recordMutations.edit(input.path, input.old_string, input.new_string, input.replace_all === true) }, signal) : operational(() => runWorkspaceTool(() => editProject(analystWorkspace(ctx), args))) }),
  defineToolBinder({ name: 'glob', description: 'Search files by glob pattern under a scoped directory, including read-only work:/// process-output and stash directories.', resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => globWorkspaceInputSchema, executor: (ctx, args) => observational(() => runWorkspaceTool(() => globProject(analystWorkspace(ctx), args))) }),
  defineToolBinder({ name: 'grep', description: grepDescription, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => grepWorkspaceInputSchema, executor: (ctx, args) => observational(() => runWorkspaceTool(() => grepProject(analystWorkspace(ctx), args))) }),
]);
export const analystPatchToolBinders: readonly ToolBinder<AnalystToolContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'apply_patch', description: 'Apply a text-only unified diff.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => applyPatchInputSchema, executor: (ctx, args) => operational(() => runWorkspaceTool(() => applyProjectPatch({ projectRoot: ctx.projectRoot,agentName:ctx.actor,filesystemWrite:true }, args))) }),
]);
