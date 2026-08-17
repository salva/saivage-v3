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
  type CompiledInvocationToolContract,
} from '../runtime/actors/llm-invocation.js';

export type ToolResult =
  | { success: true; data?: unknown; error?: never }
  | { success: false; error: string; data?: unknown };

export interface ToolDefinition<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
  readonly executor: (args: Args, signal: AbortSignal, context?: LlmToolInvocationContext) => Promise<ToolResult>;
}

export interface ToolSpecification<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
}

export interface ToolBinder<Context, Args = unknown> {
  readonly name: string;
  readonly description: string;
  bind(context: Context): ToolDefinition<Args>;
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

export function defineTool<Schema extends z.ZodTypeAny>(definition: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly executor: (args: z.infer<Schema>, signal: AbortSignal, context?: LlmToolInvocationContext) => Promise<ToolResult>;
}): ToolDefinition<z.infer<Schema>> {
  return definition;
}

export function defineToolBinder<Schema extends z.ZodTypeAny, Context = any>(definition: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: (context: Context) => Schema;
  readonly executor: (context: Context, args: z.infer<Schema>, signal: AbortSignal, invocation?: LlmToolInvocationContext) => Promise<ToolResult>;
}): ToolBinder<Context, z.infer<Schema>> {
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    bind: (context: Context) => defineTool({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema(context),
      executor: (args, signal, invocation) => definition.executor(context, args, signal, invocation),
    }),
  });
}

export function bindToolProvider<Context>(providerName: string, binders: readonly ToolBinder<Context, any>[], context: Context): ToolProvider {
  return { providerName, tools: binders.map((binder) => binder.bind(context)) };
}

export async function invokeTool(surface: InvocationSurface, name: string, args: unknown, signal: AbortSignal = new AbortController().signal, context?: LlmToolInvocationContext): Promise<ToolResult> {
  if (signal.aborted) throw abortError(signal);
  const definition = surface.tools.get(name);
  if (!definition) return { success: false, error: `Unsupported tool '${name}' for agent '${surface.agentName}'.` };
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) return { success: false, error: parsed.error.message };
  if (signal.aborted) throw abortError(signal);
  return definition.executor(parsed.data, signal, context);
}

export async function invokeToolForLlm(surface: InvocationSurface, name: string, args: unknown, context: LlmToolInvocationContext, signal?: AbortSignal): Promise<ToolResult> {
  try {
    const result = await invokeTool(surface, name, args, signal, context);
    if (signal?.aborted && isRuntimeStoppedInterruption(signal.reason)) throw signal.reason;
    return result;
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (error instanceof McpToolInvocationNotInstalledError) throw error;
    if (signal?.aborted && isRuntimeStoppedInterruption(signal.reason)) throw signal.reason;
    if (signal?.aborted) throw error;
    return { success: false, error: error instanceof Error ? error.message : String(error) };
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
    PRIMARY_TOOL_RESULT_POLICY_TEMPLATE,
  ));
}
