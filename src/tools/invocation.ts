import { z } from 'zod';

import type { ToolDefinition as LlmToolDefinition } from '../agents/llm-contracts.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import type { AgentName } from '../schemas/index.js';
import { isRuntimeStoppedInterruption } from '../runtime/actors/runtime-stopped-interruption.js';
import type { LlmToolInvocationContext } from '../runtime/actors/executing-llm-snapshot.js';
import { McpToolInvocationNotInstalledError } from '../mcp/tool-invocation-installation.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import {
  compileInvocationToolContract,
  PRIMARY_TOOL_RESULT_POLICY_TEMPLATE,
  UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE,
  type CompiledInvocationToolContract,
  type ToolEvidenceMode,
  type ToolResultPolicyTemplate,
} from '../runtime/actors/llm-invocation.js';

export type ToolResult =
  | { success: true; data?: unknown; error?: never }
  | { success: false; error: string; data?: unknown };

export type ToolExecutionEvidenceInput<M extends ToolEvidenceMode> =
  M extends 'canonical_locator'
    ? Readonly<{ kind: 'canonical_locator'; locator: string; sha256: string }>
    : M extends 'observational_query'
      ? Readonly<{ kind: 'observational_result_bytes' }>
      : Readonly<{ kind: 'none' }>;

export type ToolExecutionResult<M extends ToolEvidenceMode> =
  | Readonly<{ providerResult: Extract<ToolResult, { success: false }>; evidence: Readonly<{ kind: 'none' }> }>
  | Readonly<{ providerResult: Extract<ToolResult, { success: true }>; evidence: ToolExecutionEvidenceInput<M> }>;

export type ToolSettlementOrigin = 'executed' | 'rejected_before_execution' | 'unsupported_tool' | 'execution_failed';

export type ToolSettlementInput =
  | Readonly<{ kind: 'executed'; resultPolicyTemplate: ToolResultPolicyTemplate; execution: ToolExecutionResult<ToolEvidenceMode> }>
  | Readonly<{ kind: 'synthetic'; settlementOrigin: Exclude<ToolSettlementOrigin, 'executed'>; resultPolicyTemplate: ToolResultPolicyTemplate; providerResult: Extract<ToolResult, { success: false }>; evidence: Readonly<{ kind: 'none' }> }>;

export interface ToolDefinition<Args = unknown, M extends ToolEvidenceMode = ToolEvidenceMode> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
  readonly resultPolicyTemplate: ToolResultPolicyTemplate & Readonly<{ evidenceMode: M }>;
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
  readonly resultPolicyTemplate: ToolResultPolicyTemplate & Readonly<{ evidenceMode: M }>;
  bind(context: Context): ToolDefinition<Args, M>;
}

export type ToolProviderCleanupReason =
  | { kind: 'activation_settled'; status: 'done' | 'blocked' | 'failed' | 'cancelled' }
  | { kind: 'session_closed' }
  | { kind: 'runtime_shutdown' };

export interface ToolProvider {
  readonly providerName: string;
  readonly tools: readonly ToolDefinition<any, ToolEvidenceMode>[];
  cleanup?(reason: ToolProviderCleanupReason): Promise<void> | void;
}

export interface InvocationSurface {
  readonly agentName: AgentName;
  readonly tools: ReadonlyMap<string, ToolDefinition<any, ToolEvidenceMode>>;
  readonly providers: readonly ToolProvider[];
}

export function defineTool<Schema extends z.ZodTypeAny, M extends ToolEvidenceMode>(definition: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly resultPolicyTemplate: ToolResultPolicyTemplate & Readonly<{ evidenceMode: M }>;
  readonly executor: (args: z.infer<Schema>, signal: AbortSignal, context?: LlmToolInvocationContext) => Promise<ToolExecutionResult<M>>;
}): ToolDefinition<z.infer<Schema>, M> {
  return Object.freeze({ ...definition, resultPolicyTemplate: freezePolicyTemplate(definition.resultPolicyTemplate) });
}

export function defineToolBinder<Schema extends z.ZodTypeAny, Context = any, M extends ToolEvidenceMode = ToolEvidenceMode>(definition: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: (context: Context) => Schema;
  readonly resultPolicyTemplate: ToolResultPolicyTemplate & Readonly<{ evidenceMode: M }>;
  readonly executor: (context: Context, args: z.infer<Schema>, signal: AbortSignal, invocation?: LlmToolInvocationContext) => Promise<ToolExecutionResult<M>>;
}): ToolBinder<Context, z.infer<Schema>, M> {
  const resultPolicyTemplate = freezePolicyTemplate(definition.resultPolicyTemplate);
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    resultPolicyTemplate,
    bind: (context: Context) => defineTool({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema(context),
      resultPolicyTemplate,
      executor: (args, signal, invocation) => definition.executor(context, args, signal, invocation),
    }),
  });
}

export function bindToolProvider<Context>(providerName: string, binders: readonly ToolBinder<Context, any, ToolEvidenceMode>[], context: Context): ToolProvider {
  return { providerName, tools: binders.map((binder) => binder.bind(context)) };
}

export async function invokeTool(surface: InvocationSurface, name: string, args: unknown, signal: AbortSignal = new AbortController().signal, context?: LlmToolInvocationContext): Promise<ToolSettlementInput> {
  if (signal.aborted) throw abortError(signal);
  const definition = surface.tools.get(name);
  if (!definition) return syntheticToolSettlement('unsupported_tool', UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE, `Unsupported tool '${name}' for agent '${surface.agentName}'.`);
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) return syntheticToolSettlement('rejected_before_execution', definition.resultPolicyTemplate, parsed.error.message);
  if (signal.aborted) throw abortError(signal);
  const execution = await definition.executor(parsed.data, signal, context);
  return executedToolSettlement(definition.resultPolicyTemplate, execution);
}

export async function invokeToolForLlm(surface: InvocationSurface, name: string, args: unknown, context: LlmToolInvocationContext, signal?: AbortSignal): Promise<ToolSettlementInput> {
  try {
    const result = await invokeTool(surface, name, args, signal, context);
    if (signal?.aborted && isRuntimeStoppedInterruption(signal.reason)) throw signal.reason;
    return result;
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (error instanceof McpToolInvocationNotInstalledError) throw error;
    if (signal?.aborted && isRuntimeStoppedInterruption(signal.reason)) throw signal.reason;
    if (signal?.aborted) throw error;
    const definition = surface.tools.get(name);
    if (!definition) throw new Error(`Unsupported tool '${name}' was not settled before execution.`);
    return syntheticToolSettlement('execution_failed', definition.resultPolicyTemplate, error instanceof Error ? error.message : String(error));
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

export function surfaceCompiledInvocationTools(surface: InvocationSurface): CompiledInvocationToolContract[] {
  return Array.from(surface.tools.values(), (tool) => compileInvocationToolContract(
    llmToolDefinition(tool),
    tool.resultPolicyTemplate,
  ));
}

export function successfulToolExecution<M extends ToolEvidenceMode>(providerResult: Extract<ToolResult, { success: true }>, evidence: ToolExecutionEvidenceInput<M>): ToolExecutionResult<M> {
  return Object.freeze({ providerResult: Object.freeze(providerResult), evidence: Object.freeze(evidence) }) as ToolExecutionResult<M>;
}

export function failedToolExecution<M extends ToolEvidenceMode>(providerResult: Extract<ToolResult, { success: false }>): ToolExecutionResult<M> {
  return Object.freeze({ providerResult: Object.freeze(providerResult), evidence: Object.freeze({ kind: 'none' as const }) });
}

export function noneToolExecution(providerResult: ToolResult): ToolExecutionResult<'none'> {
  return providerResult.success
    ? successfulToolExecution(providerResult, { kind: 'none' })
    : failedToolExecution(providerResult);
}

export function observationalToolExecution(providerResult: ToolResult): ToolExecutionResult<'observational_query'> {
  return providerResult.success
    ? successfulToolExecution(providerResult, { kind: 'observational_result_bytes' })
    : failedToolExecution(providerResult);
}

export async function noneToolExecutionPromise(providerResult: Promise<ToolResult> | ToolResult): Promise<ToolExecutionResult<'none'>> {
  return noneToolExecution(await providerResult);
}

export async function observationalToolExecutionPromise(providerResult: Promise<ToolResult> | ToolResult): Promise<ToolExecutionResult<'observational_query'>> {
  return observationalToolExecution(await providerResult);
}

export function canonicalToolExecution(providerResult: ToolResult, evidence: Readonly<{ locator: string; sha256: string }>): ToolExecutionResult<'canonical_locator'> {
  return providerResult.success
    ? successfulToolExecution(providerResult, { kind: 'canonical_locator', locator: evidence.locator, sha256: evidence.sha256 })
    : failedToolExecution(providerResult);
}

export function executedNoneToolSettlement(providerResult: ToolResult): ToolSettlementInput {
  return executedToolSettlement(PRIMARY_TOOL_RESULT_POLICY_TEMPLATE, noneToolExecution(providerResult));
}

export function executedToolSettlement<M extends ToolEvidenceMode>(resultPolicyTemplate: ToolResultPolicyTemplate & Readonly<{ evidenceMode: M }>, execution: ToolExecutionResult<M>): Extract<ToolSettlementInput, { kind: 'executed' }> {
  assertExecutionEvidence(resultPolicyTemplate, execution);
  return Object.freeze({ kind: 'executed', resultPolicyTemplate: freezePolicyTemplate(resultPolicyTemplate), execution });
}

export function providerResultFromSettlement(settlement: ToolSettlementInput): ToolResult {
  return settlement.kind === 'executed' ? settlement.execution.providerResult : settlement.providerResult;
}

export function syntheticToolSettlement(origin: Exclude<ToolSettlementOrigin, 'executed'>, resultPolicyTemplate: ToolResultPolicyTemplate, error: string, data?: unknown): Extract<ToolSettlementInput, { kind: 'synthetic' }> {
  const providerResult: Extract<ToolResult, { success: false }> = data === undefined ? { success: false, error } : { success: false, error, data };
  return Object.freeze({ kind: 'synthetic', settlementOrigin: origin, resultPolicyTemplate: freezePolicyTemplate(resultPolicyTemplate), providerResult: Object.freeze(providerResult), evidence: Object.freeze({ kind: 'none' }) });
}

function assertExecutionEvidence(template: ToolResultPolicyTemplate, execution: ToolExecutionResult<ToolEvidenceMode>): void {
  if (!execution.providerResult.success) {
    if (execution.evidence.kind !== 'none') throw new Error('Failed tool execution must carry no evidence.');
    return;
  }
  const expected = template.evidenceMode === 'observational_query' ? 'observational_result_bytes' : template.evidenceMode;
  if (execution.evidence.kind !== expected) throw new Error(`Tool execution evidence '${execution.evidence.kind}' does not match fixed mode '${template.evidenceMode}'.`);
}

function freezePolicyTemplate<M extends ToolEvidenceMode>(template: ToolResultPolicyTemplate & Readonly<{ evidenceMode: M }>): ToolResultPolicyTemplate & Readonly<{ evidenceMode: M }> {
  return Object.freeze({ ...structuredClone(template), replacement: Object.freeze(structuredClone(template.replacement)) }) as ToolResultPolicyTemplate & Readonly<{ evidenceMode: M }>;
}
