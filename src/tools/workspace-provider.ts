import { applyProjectPatch, editProject, globProject, grepProject, readProject, WorkspaceToolInputError, writeProject, type WorkspaceMutationOutcome } from './project-file-tools.js';
import { applyPatchInputSchema, editWorkspaceInputSchema, globWorkspaceInputSchema, grepWorkspaceInputSchema, readWorkspaceInputSchema, writeWorkspaceInputSchema } from '../contracts/builtin-tool-inputs.js';
import { defineToolBinder, executeToolAction, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE, type ToolBinder } from './invocation.js';
import { toolFailed, toolSucceeded, type ToolActionOutcome } from '../contracts/tool-result.js';
import { boundedToolError, DiscoveryBudgetTooSmallError, DiscoveryCollectionPositionError } from './response-packer.js';
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
  readonly store?: CardService;
  readonly notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;
  readonly onRecordWritten?: (name: string) => void;
}

function failureFromError(err: unknown): ToolActionOutcome {
  return toolFailed(boundedToolError(err instanceof Error ? err.message : String(err)));
}

function isExpectedWorkspaceFailure(err: unknown): boolean {
  if (err instanceof WorkspaceToolInputError || err instanceof DiscoveryBudgetTooSmallError || err instanceof DiscoveryCollectionPositionError) return true;
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'EACCES' || code === 'EPERM';
}

async function runWorkspaceTool(action: () => Promise<unknown>): Promise<ToolActionOutcome> {
  try {
    return toolSucceeded(await action());
  } catch (err) {
    throwIfPublicationOutcomeUnknown(err);
    if (!isExpectedWorkspaceFailure(err)) throw err;
    return failureFromError(err);
  }
}

async function runWorkspaceMutation(action: () => Promise<WorkspaceMutationOutcome>): Promise<ToolActionOutcome> {
  try {
    const outcome = await action();
    return outcome.kind === 'applied' ? toolSucceeded(outcome.data) : toolFailed(outcome.error, outcome.data);
  } catch (err) {
    throwIfPublicationOutcomeUnknown(err);
    if (!isExpectedWorkspaceFailure(err)) throw err;
    return failureFromError(err);
  }
}

const collectionHelp = 'Collection pages are {total,position,returned,next,items}. Copy a non-null page next exactly into position with the same query and stable input; offsets are decoded UTF-8 byte boundaries in the complete outbound-projected canonical JSON item. An oversized item is a JsonSlice {content_hex,utf8_bytes,offset_bytes,next_offset_bytes,total_bytes} with lowercase-hex content_hex: hex-decode it, concatenate decoded bytes by item/offset, UTF-8 decode, then JSON-parse. Do not use a final slice end as a position independently.';
const readDescription = `Read a project:///, record:///, tmp:///, system:///, or read-only work:/// file or directory through scoped URLs with one exact byte-bounded response envelope. Text files and record documents return plaintext UTF-8 TextSlice {content,utf8_bytes,offset_bytes,next_offset_bytes} pages at a stateless {byte_offset} position; TextSlice content is not hex. Directories and record:/// listings return byte-packed collection pages at a stateless {item_index,item_byte_offset} position. ${collectionHelp} work:/// content is redacted before slicing. metadata_only returns bounded scalars plus the plaintext sliced path text. Files larger than about 10MB are refused rather than read inline.`;
const globDescription = `Search files in deterministic depth-first string-comparison order under project-relative, project:///, record:///, tmp:///, read-only work:///, or system:/// paths. Every call performs one complete fresh read-only scan, counts the exact total, retains only the contiguous max_results window (default 200; 1..1000), and packs matches within response_bytes (default/maximum 32768; minimum 512); it writes no result artifact. record:///<cardId> searches only effective current declared records without namespace scans. work:/// traverses supported process, stash, and work paths read-only. ${collectionHelp}`;
const grepDescription = `Stream-search text files, including files too large for inline read, with a JavaScript regular expression under project-relative, project:///, record:///, tmp:///, read-only work:///, or system:/// paths. Every call performs one complete fresh read-only scan in deterministic depth-first string-comparison order, counts the exact total, retains only the contiguous max_results window (default 200; 1..1000), and packs matches within response_bytes (default/maximum 32768; minimum 512); it writes no result artifact. ${collectionHelp} Search retains at most 2000 characters per line; content_truncated reports only that an eligible overlong suffix was not searched, not collection incompleteness. grep record:///<cardId> searches effective current declared records without namespace scans and returns record URLs as path. work:/// traverses supported process, stash, and work paths read-only, and its returned content is redacted.`;
type GlobalWorkspaceContext = AnalystToolContext | Readonly<{ projectRoot:string; agentName:AgentName; store:CardService }>;
const analystWorkspace = (ctx: GlobalWorkspaceContext): WorkspaceProviderContext => 'actor' in ctx
  ? ({ projectRoot: ctx.projectRoot, agentName:ctx.actor,store: ctx.store, notifyCard: ctx.runtime.notifyCard })
  : ({ projectRoot:ctx.projectRoot,agentName:ctx.agentName,store:ctx.store });

const observational = (action: () => Promise<ToolActionOutcome>) => executeToolAction('observational_query', action);
const operational = (action: () => Promise<ToolActionOutcome>) => executeToolAction('none', action);

export const workspaceToolBinders: readonly ToolBinder<WorkspaceProviderContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'read', description: readDescription, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => readWorkspaceInputSchema, executor: (ctx, args) => observational(() => runWorkspaceTool(() => readProject(ctx, args))) }),
  defineToolBinder({ name: 'write', description: 'Create or replace a project, record, tmp, or system file according to the named agent contract.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => writeWorkspaceInputSchema, executor: (ctx, args) => operational(() => runWorkspaceMutation(() => writeProject(ctx, args))) }),
  defineToolBinder({ name: 'edit', description: 'Replace exact text in a project, record, tmp, or system file according to the named agent contract.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => editWorkspaceInputSchema, executor: (ctx, args) => operational(() => runWorkspaceMutation(() => editProject(ctx, args))) }),
  defineToolBinder({ name: 'glob', description: globDescription, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => globWorkspaceInputSchema, executor: (ctx, args) => observational(() => runWorkspaceTool(() => globProject(ctx, args))) }),
  defineToolBinder({ name: 'grep', description: grepDescription, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => grepWorkspaceInputSchema, executor: (ctx, args) => observational(() => runWorkspaceTool(() => grepProject(ctx, args))) }),
]);
export const patchToolBinders: readonly ToolBinder<WorkspaceProviderContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'apply_patch', description: 'Apply a text-only unified diff. Patch paths are project-relative only; scoped URL paths such as work:/// are rejected in diff headers.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => applyPatchInputSchema, executor: (ctx, args) => operational(() => runWorkspaceTool(() => applyProjectPatch(ctx, args))) }),
]);
export const globalWorkspaceObservationToolBinders: readonly ToolBinder<GlobalWorkspaceContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'read', description: readDescription, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => readWorkspaceInputSchema, executor: (ctx, args) => observational(() => runWorkspaceTool(() => readProject(analystWorkspace(ctx), args))) }),
  defineToolBinder({ name: 'glob', description: globDescription, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => globWorkspaceInputSchema, executor: (ctx, args) => observational(() => runWorkspaceTool(() => globProject(analystWorkspace(ctx), args))) }),
  defineToolBinder({ name: 'grep', description: grepDescription, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => grepWorkspaceInputSchema, executor: (ctx, args) => observational(() => runWorkspaceTool(() => grepProject(analystWorkspace(ctx), args))) }),
]);
const analystWorkspaceMutationToolBinders: readonly ToolBinder<AnalystToolContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'write', description: 'Create or replace a project, record, tmp, or system file according to the named agent contract.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => writeWorkspaceInputSchema, executor: (ctx, args, signal) => args.path.startsWith('record:///') ? runAuditedAnalystTool(ctx, args, { action: 'record.write', safety_class: 'low', target_kind: 'card', getTargetId: (input) => input.path, lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' }, mutate: (_prepared, input, mutation) => mutation.services.recordMutations.write(input.path, input.content) }, signal) : operational(() => runWorkspaceMutation(() => writeProject(analystWorkspace(ctx), args))) }),
  defineToolBinder({ name: 'edit', description: 'Replace exact text in a project, record, tmp, or system file according to the named agent contract.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => editWorkspaceInputSchema, executor: (ctx, args, signal) => args.path.startsWith('record:///') ? runAuditedAnalystTool(ctx, args, { action: 'record.edit', safety_class: 'low', target_kind: 'card', getTargetId: (input) => input.path, lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' }, mutate: (_prepared, input, mutation) => mutation.services.recordMutations.edit(input.path, input.old_string, input.new_string, input.replace_all === true) }, signal) : operational(() => runWorkspaceMutation(() => editProject(analystWorkspace(ctx), args))) }),
]);
export const analystWorkspaceToolBinders: readonly ToolBinder<AnalystToolContext, any>[] = Object.freeze([
  globalWorkspaceObservationToolBinders[0]!,
  ...analystWorkspaceMutationToolBinders,
  ...globalWorkspaceObservationToolBinders.slice(1),
]);
export const analystPatchToolBinders: readonly ToolBinder<AnalystToolContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'apply_patch', description: 'Apply a text-only unified diff.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => applyPatchInputSchema, executor: (ctx, args) => operational(() => runWorkspaceTool(() => applyProjectPatch({ projectRoot: ctx.projectRoot,agentName:ctx.actor }, args))) }),
]);
