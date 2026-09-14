import { z } from 'zod';

import type { ToolDefinition as LlmToolDefinition } from '../agents/llm-contracts.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import type { AgentName, ToolResultPolicyTemplate } from '../schemas/index.js';
import type { LlmToolInvocationContext } from '../runtime/actors/executing-llm-snapshot.js';
import { McpToolInvocationNotInstalledError } from '../mcp/tool-invocation-installation.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import { toolFailed, type ToolActionOutcome } from '../contracts/tool-result.js';
import { boundedToolError, DiscoveryBudgetTooSmallError, DiscoveryCollectionPositionError } from './response-packer.js';

type ToolEvidenceMode = ToolResultPolicyTemplate['evidenceMode'];

type ToolExecutionEvidenceInput<M extends ToolEvidenceMode> =
  M extends 'canonical_locator'
    ? { kind: 'canonical_locator'; locator: string; sha256: string }
    : M extends 'observational_query'
      ? { kind: 'observational_result_bytes' }
      : { kind: 'none' };

export type ToolExecutionResult<M extends ToolEvidenceMode> =
  | Readonly<{ providerOutcome: ToolActionOutcome; evidence: { kind: 'none' } }>
  | Readonly<{
      providerOutcome: ToolActionOutcome;
      evidence: ToolExecutionEvidenceInput<M>;
    }>;

export type ExecutedToolSettlement = Readonly<{ kind: 'executed'; execution: ToolExecutionResult<ToolEvidenceMode> }>;
type SyntheticToolSettlementOrigin = 'rejected_before_execution' | 'unsupported_tool' | 'execution_failed';
type SyntheticToolSettlement = Readonly<{ kind: SyntheticToolSettlementOrigin; providerOutcome: ToolActionOutcome }>;
export type ToolSettlementInput = ExecutedToolSettlement | SyntheticToolSettlement;

export function syntheticToolSettlement(kind: SyntheticToolSettlementOrigin, error: string, data?: unknown): SyntheticToolSettlement {
  return Object.freeze({ kind, providerOutcome: toolFailed(error, data) });
}

export function executedNoneSettlement(providerOutcome: ToolActionOutcome): ExecutedToolSettlement {
  return Object.freeze({ kind: 'executed', execution: Object.freeze({ providerOutcome, evidence: Object.freeze({ kind: 'none' }) }) });
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

export function executedToolOutcome<M extends 'none' | 'observational_query'>(mode: M, outcome: ToolActionOutcome): ToolExecutionResult<M> {
  if (outcome.kind === 'succeeded' && mode === 'observational_query')
    return { providerOutcome: outcome, evidence: { kind: 'observational_result_bytes' } } as ToolExecutionResult<M>;
  return { providerOutcome: outcome, evidence: { kind: 'none' } } as ToolExecutionResult<M>;
}

export function executeToolAction<M extends 'none' | 'observational_query'>(mode: M, action: () => Promise<ToolActionOutcome>): Promise<ToolExecutionResult<M>> {
  return action().then((outcome) => executedToolOutcome(mode, outcome));
}

export function executeCanonicalLocatorToolAction(action: () => Promise<{ outcome: ToolActionOutcome; locator: string; sha256: string }>): Promise<ToolExecutionResult<'canonical_locator'>> {
  return action().then((outcome) => outcome.outcome.kind === 'succeeded'
    ? { providerOutcome: outcome.outcome, evidence: { kind: 'canonical_locator', locator: outcome.locator, sha256: outcome.sha256 } }
    : { providerOutcome: outcome.outcome, evidence: { kind: 'none' } });
}

export interface ToolDefinition<Args = unknown, M extends ToolEvidenceMode = ToolEvidenceMode> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
  readonly resultPolicyTemplate: ToolResultPolicyTemplate & { evidenceMode: M };
  readonly executor: (args: Args, signal: AbortSignal, context?: LlmToolInvocationContext) => Promise<ToolExecutionResult<M>>;
}

interface ToolSpecification<Args = unknown> {
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
  | { kind: 'activation_settled'; status: 'done' | 'blocked' | 'failed' | 'cancelled' | 'stopped' }
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

export function isExpectedToolInputFailure(error: unknown): error is ToolArgumentValidationError | DiscoveryBudgetTooSmallError | DiscoveryCollectionPositionError {
  return error instanceof ToolArgumentValidationError
    || error instanceof DiscoveryBudgetTooSmallError
    || error instanceof DiscoveryCollectionPositionError;
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
  let executorEntered = false;
  try {
    const definition = surface.tools.get(name);
    if (!definition) return syntheticToolSettlement('unsupported_tool', `Unsupported tool '${name}' for agent '${surface.agentName}'.`);
    const parsed = definition.inputSchema.safeParse(args);
    if (!parsed.success) return syntheticToolSettlement('rejected_before_execution', parsed.error.message);
    if (signal?.aborted) return syntheticToolSettlement('rejected_before_execution', 'Tool execution was cancelled before entry.');
    executorEntered = true;
    const execution = await definition.executor(parsed.data, signal ?? new AbortController().signal, context);
    return { kind: 'executed', execution };
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (error instanceof McpToolInvocationNotInstalledError) throw error;
    if (isExpectedToolInputFailure(error)) {
      const message = boundedToolError(error.message);
      return executorEntered
        ? executedNoneSettlement(toolFailed(message))
        : syntheticToolSettlement('rejected_before_execution', message);
    }
    if (signal?.aborted && !executorEntered) return syntheticToolSettlement('rejected_before_execution', 'Tool execution was cancelled before entry.');
    if (signal?.aborted && error === signal.reason)
      return syntheticToolSettlement('execution_failed', boundedToolError(error instanceof Error ? error.message : String(error)));
    throw error;
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

export function llmToolDefinition(tool: ToolSpecification<unknown>): LlmToolDefinition {
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
