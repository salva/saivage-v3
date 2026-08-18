import { z } from 'zod';

import type { ToolDefinition as LlmToolDefinition } from '../agents/llm-contracts.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import type { AgentName, ToolResultPolicyTemplate } from '../schemas/index.js';
import { isRuntimeStoppedInterruption } from '../runtime/actors/runtime-stopped-interruption.js';
import type { LlmToolInvocationContext } from '../runtime/actors/executing-llm-snapshot.js';
import { McpToolInvocationNotInstalledError } from '../mcp/tool-invocation-installation.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';

export type ToolResult =
  | { success: true; data?: unknown; error?: never }
  | { success: false; error: string; data?: unknown };

export type ToolEvidenceMode = ToolResultPolicyTemplate['evidenceMode'];

export type ToolExecutionEvidenceInput<M extends ToolEvidenceMode> =
  M extends 'canonical_locator'
    ? { kind: 'canonical_locator'; locator: string; sha256: string }
    : M extends 'observational_query'
      ? { kind: 'observational_result_bytes' }
      : { kind: 'none' };

export type ToolExecutionResult<M extends ToolEvidenceMode> =
  | Readonly<{ providerResult: Extract<ToolResult, { success: false }>; evidence: { kind: 'none' } }>
  | Readonly<{
      providerResult: Extract<ToolResult, { success: true }>;
      evidence: ToolExecutionEvidenceInput<M>;
    }>;

export type ExecutedToolSettlement = Readonly<{ kind: 'executed'; execution: ToolExecutionResult<ToolEvidenceMode> }>;
export type SyntheticToolSettlementOrigin = 'rejected_before_execution' | 'unsupported_tool' | 'execution_failed';
export type SyntheticToolSettlement = Readonly<{ kind: SyntheticToolSettlementOrigin; providerResult: Extract<ToolResult, { success: false }> }>;
export type ToolSettlementInput = ExecutedToolSettlement | SyntheticToolSettlement;

export function syntheticToolSettlement(kind: SyntheticToolSettlementOrigin, error: string, data?: unknown): SyntheticToolSettlement {
  const providerResult: Extract<ToolResult, { success: false }> = data === undefined ? { success: false, error } : { success: false, error, data };
  return Object.freeze({ kind, providerResult });
}

export function executedNoneSettlement(providerResult: ToolResult): ExecutedToolSettlement {
  return Object.freeze({ kind: 'executed', execution: Object.freeze({ providerResult, evidence: Object.freeze({ kind: 'none' }) } as ToolExecutionResult<'none'>) });
}

export function settlementProviderResult(settlement: ToolSettlementInput): ToolResult {
  return settlement.kind === 'executed' ? settlement.execution.providerResult : settlement.providerResult;
}

export const OPERATIONAL_RESULT_POLICY_TEMPLATE: ToolResultPolicyTemplate & { evidenceMode: 'none' } = Object.freeze({
  storage: 'durable',
  replacement: Object.freeze({ kind: 'retain' }),
  settledAudience: 'primary_and_summarizer',
  evidenceMode: 'none',
});
export const OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE: ToolResultPolicyTemplate & { evidenceMode: 'observational_query' } = Object.freeze({
  storage: 'durable',
  replacement: Object.freeze({ kind: 'retain' }),
  settledAudience: 'summarizer_only',
  evidenceMode: 'observational_query',
});
export const CANONICAL_LOCATOR_RESULT_POLICY_TEMPLATE: ToolResultPolicyTemplate & { evidenceMode: 'canonical_locator' } = Object.freeze({
  storage: 'durable',
  replacement: Object.freeze({ kind: 'retain' }),
  settledAudience: 'summarizer_only',
  evidenceMode: 'canonical_locator',
});
export const MCP_RESULT_POLICY_TEMPLATE: ToolResultPolicyTemplate & { evidenceMode: 'none' } = OPERATIONAL_RESULT_POLICY_TEMPLATE;
export const EMIT_RESULT_POLICY_TEMPLATE: ToolResultPolicyTemplate & { evidenceMode: 'none' } = OPERATIONAL_RESULT_POLICY_TEMPLATE;
export const UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE: ToolResultPolicyTemplate & { evidenceMode: 'none' } = OPERATIONAL_RESULT_POLICY_TEMPLATE;

export function executedProviderResult<M extends 'none' | 'observational_query'>(mode: M, result: ToolResult): ToolExecutionResult<M> {
  if (result.success && mode === 'observational_query')
    return { providerResult: result, evidence: { kind: 'observational_result_bytes' } } as ToolExecutionResult<M>;
  return { providerResult: result, evidence: { kind: 'none' } } as ToolExecutionResult<M>;
}

export function executeToolAction<M extends 'none' | 'observational_query'>(mode: M, action: () => Promise<ToolResult>): Promise<ToolExecutionResult<M>> {
  return action().then((result) => executedProviderResult(mode, result));
}

export function executeCanonicalLocatorToolAction(action: () => Promise<{ result: ToolResult; locator: string; sha256: string }>): Promise<ToolExecutionResult<'canonical_locator'>> {
  return action().then((outcome) => outcome.result.success
    ? { providerResult: outcome.result, evidence: { kind: 'canonical_locator', locator: outcome.locator, sha256: outcome.sha256 } }
    : { providerResult: outcome.result, evidence: { kind: 'none' } });
}

export interface ToolDefinition<Args = unknown, M extends ToolEvidenceMode = ToolEvidenceMode> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
  readonly resultPolicyTemplate: ToolResultPolicyTemplate & { evidenceMode: M };
  readonly executor: (args: Args, signal: AbortSignal, context?: LlmToolInvocationContext) => Promise<ToolExecutionResult<M>>;
}

export interface ToolSpecification<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
}

export interface ToolBinder<Context, Args = unknown, M extends ToolEvidenceMode = ToolEvidenceMode> {
  readonly name: string;
  readonly description: string;
  readonly resultPolicyTemplate: ToolResultPolicyTemplate & { evidenceMode: M };
  bind(context: Context): ToolDefinition<Args, M>;
}

export type ToolProviderCleanupReason =
  | { kind: 'activation_settled'; status: 'done' | 'blocked' | 'failed' | 'cancelled' }
  | { kind: 'session_closed' }
  | { kind: 'runtime_shutdown' };

export interface ToolProvider {
  readonly providerName: string;
  readonly tools: readonly ToolDefinition<any>[];
  cleanup?(reason: ToolProviderCleanupReason): Promise<void> | void;
}

export interface InvocationSurface {
  readonly agentName: AgentName;
  readonly tools: ReadonlyMap<string, ToolDefinition<any>>;
  readonly providers: readonly ToolProvider[];
}

export class ToolArgumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentValidationError';
  }
}

export function defineTool<Schema extends z.ZodTypeAny, M extends ToolEvidenceMode>(definition: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly resultPolicyTemplate: ToolResultPolicyTemplate & { evidenceMode: M };
  readonly executor: (args: z.infer<Schema>, signal: AbortSignal, context?: LlmToolInvocationContext) => Promise<ToolExecutionResult<M>>;
}): ToolDefinition<z.infer<Schema>, M> {
  return definition;
}

export function defineToolBinder<Schema extends z.ZodTypeAny, Context = any, M extends ToolEvidenceMode = ToolEvidenceMode>(definition: {
  readonly name: string;
  readonly description: string;
  readonly resultPolicyTemplate: ToolResultPolicyTemplate & { evidenceMode: M };
  readonly inputSchema: (context: Context) => Schema;
  readonly executor: (context: Context, args: z.infer<Schema>, signal: AbortSignal, invocation?: LlmToolInvocationContext) => Promise<ToolExecutionResult<M>>;
}): ToolBinder<Context, z.infer<Schema>, M> {
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    resultPolicyTemplate: definition.resultPolicyTemplate,
    bind: (context: Context) => defineTool({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema(context),
      resultPolicyTemplate: definition.resultPolicyTemplate,
      executor: (args, signal, invocation) => definition.executor(context, args, signal, invocation),
    }),
  });
}

export function bindToolProvider<Context>(providerName: string, binders: readonly ToolBinder<Context, any>[], context: Context): ToolProvider {
  return { providerName, tools: binders.map((binder) => binder.bind(context)) };
}

export async function invokeTool(surface: InvocationSurface, name: string, args: unknown, signal: AbortSignal = new AbortController().signal, context?: LlmToolInvocationContext): Promise<ToolExecutionResult<ToolEvidenceMode>> {
  if (signal.aborted) throw abortError(signal);
  const definition = surface.tools.get(name);
  if (!definition) throw new Error(`Unsupported tool '${name}' for agent '${surface.agentName}'.`);
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) throw new ToolArgumentValidationError(parsed.error.message);
  if (signal.aborted) throw abortError(signal);
  return definition.executor(parsed.data, signal, context);
}

export async function invokeToolForLlm(surface: InvocationSurface, name: string, args: unknown, context: LlmToolInvocationContext, signal?: AbortSignal): Promise<ToolSettlementInput> {
  try {
    if (signal?.aborted) throw abortError(signal);
    const definition = surface.tools.get(name);
    if (!definition) return syntheticToolSettlement('unsupported_tool', `Unsupported tool '${name}' for agent '${surface.agentName}'.`);
    const parsed = definition.inputSchema.safeParse(args);
    if (!parsed.success) return syntheticToolSettlement('rejected_before_execution', parsed.error.message);
    const execution = await definition.executor(parsed.data, signal ?? new AbortController().signal, context);
    if (signal?.aborted && isRuntimeStoppedInterruption(signal.reason)) throw signal.reason;
    return { kind: 'executed', execution };
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (error instanceof McpToolInvocationNotInstalledError) throw error;
    if (error instanceof ToolArgumentValidationError) return syntheticToolSettlement('rejected_before_execution', error.message);
    if (signal?.aborted && isRuntimeStoppedInterruption(signal.reason)) throw signal.reason;
    if (signal?.aborted) throw error;
    return syntheticToolSettlement('execution_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function cleanupInvocationSurface(surface: InvocationSurface, reason: ToolProviderCleanupReason): Promise<void> {
  await Promise.all(surface.providers.map((provider) => provider.cleanup?.(reason)));
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' ? reason : 'Tool invocation was interrupted.');
}

export function llmToolDefinition(tool: ToolSpecification<any>): LlmToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchemaMini(tool.inputSchema),
    },
  };
}

export function surfaceToolDefinitions(surface: InvocationSurface): LlmToolDefinition[] {
  return Array.from(surface.tools.values(), llmToolDefinition);
}
