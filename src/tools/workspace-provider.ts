import {
  applyProjectPatch,
  editProject,
  globProject,
  grepProject,
  readProject,
  readWorkspaceImageSource,
  WorkspaceToolInputError,
  writeProject,
  type WorkspaceMutationOutcome,
} from './project-file-tools.js';
import {
  applyPatchInputSchema,
  editWorkspaceInputSchema,
  globWorkspaceInputSchema,
  grepWorkspaceInputSchema,
  readWorkspaceInputSchema,
  writeWorkspaceInputSchema,
  toolFailed,
  toolSucceeded,
  viewImageInputSchema,
  MAX_IMAGE_SOURCE_BYTES,
  throwIfPublicationOutcomeUnknown,
  type ToolActionOutcome,
} from '../contracts/index.js';
import {
  defineToolBinder,
  executeToolAction,
  executedToolOutcome,
  isExpectedToolInputFailure,
  OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
  OPERATIONAL_RESULT_POLICY_TEMPLATE,
  type ToolBinder,
  type ToolExecutionResult,
} from './invocation.js';
import { boundedToolError } from './response-packer.js';
import type { AgentName } from '../schemas/index.js';
import type { CardService } from '../cards/store-api.js';
import type { CardNotification } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import type { ToolContext as AnalystToolContext } from './analyst-tool-types.js';
import { runAuditedAnalystTool } from '../agents/tool-api.js';
import { normalizeWorkspaceImage } from './image-decode.js';
import { ImageInputError } from './image-input-error.js';
import { toolRecordSucceeded } from '../contracts/index.js';

export interface WorkspaceProviderContext {
  readonly assertGlobalSourceWrite?: (absolutePath: string) => void;
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
  if (err instanceof WorkspaceToolInputError || isExpectedToolInputFailure(err)) return true;
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? (err as NodeJS.ErrnoException).code
      : undefined;
  return (
    code === 'ENOENT' ||
    code === 'ENOTDIR' ||
    code === 'EISDIR' ||
    code === 'EACCES' ||
    code === 'EPERM'
  );
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

async function runWorkspaceRead(
  ctx: WorkspaceProviderContext,
  args: Parameters<typeof readProject>[1],
): Promise<ToolActionOutcome> {
  try {
    const result = await readProject(ctx, args);
    return toolRecordSucceeded(result.data, 'read', result.record_observations);
  } catch (err) {
    throwIfPublicationOutcomeUnknown(err);
    if (!isExpectedWorkspaceFailure(err)) throw err;
    return failureFromError(err);
  }
}

async function runWorkspaceMutation(
  action: () => Promise<WorkspaceMutationOutcome>,
): Promise<ToolActionOutcome> {
  try {
    const outcome = await action();
    return outcome.kind === 'applied'
      ? 'record_observations' in outcome && outcome.record_observations
        ? toolRecordSucceeded(outcome.data, 'mutation', outcome.record_observations)
        : toolSucceeded(outcome.data)
      : toolFailed(outcome.error, outcome.data);
  } catch (err) {
    throwIfPublicationOutcomeUnknown(err);
    if (!isExpectedWorkspaceFailure(err)) throw err;
    return failureFromError(err);
  }
}

const collectionHelp =
  'Collection pages are {total,position,returned,next,items}. Copy a non-null page next exactly into position with the same query and stable input; offsets are decoded UTF-8 byte boundaries in the complete outbound-projected canonical JSON item. An oversized item is a JsonSlice {content_hex,utf8_bytes,offset_bytes,next_offset_bytes,total_bytes} with lowercase-hex content_hex: hex-decode it, concatenate decoded bytes by item/offset, UTF-8 decode, then JSON-parse. Do not use a final slice end as a position independently.';
const readAddressHelp =
  'Native relative paths default to the project root; native absolute paths may name ordinary process-accessible files outside it. Explicit symlink targets use the same secret/private-source restrictions. project:/// stays contained; record:///, tmp:///, read-only work:/// and system:/// retain their resource contracts. Generic .saivage paths and known credential sources are refused; use resource URLs for admitted Saivage data.';
const readDescription = `Read a file or directory with one exact byte-bounded response envelope. ${readAddressHelp} Explicit ordinary build/dependency files are readable; directory listings omit traversal-excluded entries. Text files and record documents return plaintext UTF-8 TextSlice {content,utf8_bytes,offset_bytes,next_offset_bytes} pages at a stateless {byte_offset} position; TextSlice content is not hex. Directories and record:/// listings return byte-packed collection pages at a stateless {item_index,item_byte_offset} position. ${collectionHelp} work:/// content is redacted before slicing. metadata_only returns bounded scalars plus the plaintext sliced path text. Files larger than about 10MB are refused rather than read inline. Direct reads and directory listings are not filtered by project search scope; read .saivage-search-ignore by that exact path to inspect it.`;
const recordMutationHelp =
  'Record writes require record:///<name>?card=<card-id>, e.g. record:///status.md?card=project; &v=N is read-only.';
const projectSearchScopeHelp =
  'Recursive discovery skips dependency/build/cache and .git directories and does not follow encountered directory symlinks; an explicit symlink root resolves normally. Native searches resolving inside the project and project:/// searches apply .saivage-search-ignore literal project-root-relative directory exclusions; external native and system:/// searches do not. No Git state is inferred. Do not exclude required source or evidence merely to shorten a search or conceal a failed check. Explicit files remain searchable/readable without loading that policy. External native results are reusable absolute paths; project-native results are project-relative.';
const globDescription = `Search files in deterministic depth-first string-comparison order. ${readAddressHelp} Patterns match relative to the selected root or the displayed path. Every call performs one complete fresh read-only scan of its eligible domain, counts the exact total, retains only the contiguous max_results window (default 200; 1..1000), and packs matches within response_bytes (default/maximum 32768; minimum 512); it writes no result artifact. ${projectSearchScopeHelp} record:///<cardId> searches only effective current declared records without namespace scans. work:/// traverses supported process, stash, and work paths read-only. ${collectionHelp}`;
const grepDescription = `Stream-search text files, including files too large for inline read, with a JavaScript regular expression. ${readAddressHelp} Every call performs one complete fresh read-only scan of its eligible domain in deterministic depth-first string-comparison order, counts the exact total, retains only the contiguous max_results window (default 200; 1..1000), and packs matches within response_bytes (default/maximum 32768; minimum 512); it writes no result artifact. ${projectSearchScopeHelp} ${collectionHelp} Search retains at most 2000 characters per line; content_truncated reports only that an eligible overlong suffix was not searched, not collection incompleteness. grep record:///<cardId> searches effective current declared records without namespace scans and returns record URLs as path. work:/// traverses supported process, stash, and work paths read-only, and its returned content is redacted.`;
type GlobalWorkspaceContext =
  | AnalystToolContext
  | Readonly<{ projectRoot: string; agentName: AgentName; store: CardService }>;
const analystWorkspace = (ctx: GlobalWorkspaceContext): WorkspaceProviderContext =>
  'actor' in ctx
    ? {
        projectRoot: ctx.projectRoot,
        agentName: ctx.policyAgentName,
        store: ctx.store,
        notifyCard: ctx.runtime.notifyCard,
        assertGlobalSourceWrite: ctx.assertGlobalSourceWrite,
      }
    : { projectRoot: ctx.projectRoot, agentName: ctx.agentName, store: ctx.store };

const observational = (action: () => Promise<ToolActionOutcome>) =>
  executeToolAction('observational_query', action);
const operational = (action: () => Promise<ToolActionOutcome>) => executeToolAction('none', action);

const imageDescription =
  'Inspect one explicitly named non-secret PNG/JPEG at a project path, project:///, work:/// or own-card tmp:/// URL. Returns a normalized PNG snapshot: internal LLM calls retain an immutable conversation selection; external calls receive PNG bytes without an internal transcript. Never inspect credential/configuration screens: pixels cannot be redacted. Default longest side 1600; max_dimension integer 1..16384 or original overrides local resizing only. Orientation precedes aspect-preserving reduction; no upscaling or source edits. Provider detail is omitted (auto); local original does not force provider-original pixels. Source <=32 MiB/40 million pixels, single frame; selected PNG <=16 MiB. If text is illegible, use a larger override or a focused screenshot from existing commands; never invent unreadable text.';
const imagePolicy = Object.freeze({
  ...OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
  settledAudience: 'primary_and_summarizer' as const,
});
async function viewImage(
  ctx: WorkspaceProviderContext,
  args: { path: string; max_dimension?: number | 'original' },
  signal: AbortSignal,
): Promise<ToolExecutionResult<'observational_query'>> {
  signal.throwIfAborted();
  let source: ReturnType<typeof readWorkspaceImageSource>;
  try {
    source = readWorkspaceImageSource(ctx, args.path, MAX_IMAGE_SOURCE_BYTES);
  } catch (error) {
    if (!isExpectedWorkspaceFailure(error)) throw error;
    return executedToolOutcome('observational_query', failureFromError(error));
  }
  let selected: Awaited<ReturnType<typeof normalizeWorkspaceImage>>;
  try {
    selected = await normalizeWorkspaceImage(source.bytes, source.sourcePath, args.max_dimension);
  } catch (error) {
    if (!(error instanceof ImageInputError)) throw error;
    signal.throwIfAborted();
    return executedToolOutcome('observational_query', failureFromError(error));
  }
  signal.throwIfAborted();
  return {
    ...executedToolOutcome('observational_query', toolSucceeded(selected.data)),
    producedContent: {
      projectRoot: ctx.projectRoot,
      blocks: [
        {
          type: 'image',
          bytes: selected.bytes,
          dimensions: selected.data.sent_dimensions,
        },
      ],
    },
  };
}

function auditedWorkspaceMutation<P extends { path: string }>(
  ctx: AnalystToolContext,
  args: P,
  action: 'workspace.write' | 'workspace.edit',
  mutate: () => Promise<WorkspaceMutationOutcome>,
  signal?: AbortSignal,
) {
  return runAuditedAnalystTool(
    ctx,
    args,
    {
      action,
      safety_class: 'low',
      target_kind: null,
      getTargetId: (input) => input.path,
      lifecycle: { kind: 'runtime_cancellation' },
      mutate: async () => {
        const outcome = await runWorkspaceMutation(mutate);
        return outcome.kind === 'succeeded'
          ? { kind: 'returned', success: true, data: outcome.data }
          : { kind: 'returned', success: false, error: outcome.error, data: outcome.data };
      },
    },
    signal,
  );
}

export const workspaceToolBinders: readonly ToolBinder<WorkspaceProviderContext, any>[] =
  Object.freeze([
    defineToolBinder({
      name: 'view_image',
      description: imageDescription,
      resultPolicyTemplate: imagePolicy,
      inputSchema: () => viewImageInputSchema,
      executor: (ctx, args, signal) => viewImage(ctx, args, signal),
    }),
    defineToolBinder({
      name: 'read',
      description: readDescription,
      resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
      inputSchema: () => readWorkspaceInputSchema,
      executor: (ctx, args) => observational(() => runWorkspaceRead(ctx, args)),
    }),
    defineToolBinder({
      name: 'write',
      description: `Create or replace a project, record, tmp, or system file according to the named agent contract. ${recordMutationHelp}`,
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => writeWorkspaceInputSchema,
      executor: (ctx, args) =>
        operational(() => runWorkspaceMutation(() => writeProject(ctx, args))),
    }),
    defineToolBinder({
      name: 'edit',
      description: `Replace exact text in a project, record, tmp, or system file according to the named agent contract. ${recordMutationHelp}`,
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => editWorkspaceInputSchema,
      executor: (ctx, args) =>
        operational(() => runWorkspaceMutation(() => editProject(ctx, args))),
    }),
    defineToolBinder({
      name: 'glob',
      description: globDescription,
      resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
      inputSchema: () => globWorkspaceInputSchema,
      executor: (ctx, args) => observational(() => runWorkspaceTool(() => globProject(ctx, args))),
    }),
    defineToolBinder({
      name: 'grep',
      description: grepDescription,
      resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
      inputSchema: () => grepWorkspaceInputSchema,
      executor: (ctx, args) => observational(() => runWorkspaceTool(() => grepProject(ctx, args))),
    }),
  ]);
export const patchToolBinders: readonly ToolBinder<WorkspaceProviderContext, any>[] = Object.freeze(
  [
    defineToolBinder({
      name: 'apply_patch',
      description:
        'Apply a text-only unified diff. Patch paths are project-relative only; scoped URL paths such as work:/// are rejected in diff headers.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => applyPatchInputSchema,
      executor: (ctx, args) =>
        operational(() => runWorkspaceTool(() => applyProjectPatch(ctx, args))),
    }),
  ],
);
const globalReadBinder = defineToolBinder<typeof readWorkspaceInputSchema, GlobalWorkspaceContext>({
  name: 'read',
  description: readDescription,
  resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
  inputSchema: () => readWorkspaceInputSchema,
  executor: (ctx, args) => observational(() => runWorkspaceRead(analystWorkspace(ctx), args)),
});
const globalImageBinder = defineToolBinder<typeof viewImageInputSchema, GlobalWorkspaceContext>({
  name: 'view_image',
  description: imageDescription,
  resultPolicyTemplate: imagePolicy,
  inputSchema: () => viewImageInputSchema,
  executor: (ctx, args, signal) => viewImage(analystWorkspace(ctx), args, signal),
});
const globalGlobBinder = defineToolBinder<typeof globWorkspaceInputSchema, GlobalWorkspaceContext>({
  name: 'glob',
  description: globDescription,
  resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
  inputSchema: () => globWorkspaceInputSchema,
  executor: (ctx, args) =>
    observational(() => runWorkspaceTool(() => globProject(analystWorkspace(ctx), args))),
});
const globalGrepBinder = defineToolBinder<typeof grepWorkspaceInputSchema, GlobalWorkspaceContext>({
  name: 'grep',
  description: grepDescription,
  resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
  inputSchema: () => grepWorkspaceInputSchema,
  executor: (ctx, args) =>
    observational(() => runWorkspaceTool(() => grepProject(analystWorkspace(ctx), args))),
});
export const globalWorkspaceObservationToolBinders: readonly ToolBinder<
  GlobalWorkspaceContext,
  any
>[] = Object.freeze([globalReadBinder, globalImageBinder, globalGlobBinder, globalGrepBinder]);
const analystWorkspaceMutationToolBinders: readonly ToolBinder<AnalystToolContext, any>[] =
  Object.freeze([
    defineToolBinder({
      name: 'write',
      description: `Create or replace a project, record, tmp, or system file according to the named agent contract. ${recordMutationHelp}`,
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => writeWorkspaceInputSchema,
      executor: (ctx, args, signal) =>
        args.path.startsWith('record:///')
          ? runAuditedAnalystTool(
              ctx,
              args,
              {
                action: 'record.write',
                safety_class: 'low',
                target_kind: 'card',
                getTargetId: (input) => input.path,
                lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' },
                mutate: (_prepared, input, mutation) =>
                  mutation.services.recordMutations.write(input.path, input.content),
              },
              signal,
            )
          : auditedWorkspaceMutation(
              ctx,
              args,
              'workspace.write',
              () => writeProject(analystWorkspace(ctx), args),
              signal,
            ),
    }),
    defineToolBinder({
      name: 'edit',
      description: `Replace exact text in a project, record, tmp, or system file according to the named agent contract. ${recordMutationHelp}`,
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => editWorkspaceInputSchema,
      executor: (ctx, args, signal) =>
        args.path.startsWith('record:///')
          ? runAuditedAnalystTool(
              ctx,
              args,
              {
                action: 'record.edit',
                safety_class: 'low',
                target_kind: 'card',
                getTargetId: (input) => input.path,
                lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' },
                mutate: (_prepared, input, mutation) =>
                  mutation.services.recordMutations.edit(
                    input.path,
                    input.old_string,
                    input.new_string,
                    input.replace_all === true,
                  ),
              },
              signal,
            )
          : auditedWorkspaceMutation(
              ctx,
              args,
              'workspace.edit',
              () => editProject(analystWorkspace(ctx), args),
              signal,
            ),
    }),
  ]);
export const analystWorkspaceToolBinders: readonly ToolBinder<AnalystToolContext, any>[] =
  Object.freeze([
    globalReadBinder,
    globalImageBinder,
    ...analystWorkspaceMutationToolBinders,
    globalGlobBinder,
    globalGrepBinder,
  ]);
export const analystPatchToolBinders: readonly ToolBinder<AnalystToolContext, any>[] =
  Object.freeze([
    defineToolBinder({
      name: 'apply_patch',
      description: 'Apply a text-only unified diff.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => applyPatchInputSchema,
      executor: (ctx, args) =>
        operational(() =>
          runWorkspaceTool(() =>
            applyProjectPatch(
              {
                projectRoot: ctx.projectRoot,
                agentName: ctx.policyAgentName,
                assertGlobalSourceWrite: ctx.assertGlobalSourceWrite,
              },
              args,
            ),
          ),
        ),
    }),
  ]);
