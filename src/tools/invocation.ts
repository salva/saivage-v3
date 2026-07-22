import { z } from 'zod';

import type { ToolDefinition as LlmToolDefinition } from '../agents/llm-contracts.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import type { AgentName } from '../schemas/index.js';
import { isRuntimeStoppedInterruption } from '../runtime/actors/runtime-stopped-interruption.js';
import type { LlmToolInvocationContext } from '../runtime/actors/executing-llm-snapshot.js';
import { McpToolInvocationNotInstalledError } from '../mcp/tool-invocation-installation.js';
import { rethrowAppLogPublicationError } from '../persistence/app-log.js';

export type ToolResult =
  | { success: true; data?: unknown; error?: never }
  | { success: false; error: string; data?: unknown };

export interface ToolDefinition<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
  readonly executor: (args: Args, signal: AbortSignal, context?: LlmToolInvocationContext) => Promise<ToolResult>;
}

export type ToolProviderCleanupReason =
  | { kind: 'activation_settled'; status: 'done' | 'blocked' | 'failed' | 'cancelled' }
  | { kind: 'publication_terminal'; error: Error }
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

export function buildInvocationSurface(agentName: AgentName, providers: readonly ToolProvider[]): InvocationSurface {
  const tools = new Map<string, ToolDefinition<any>>();
  for (const provider of providers) {
    for (const tool of provider.tools) {
      if (tools.has(tool.name)) throw new Error(`Duplicate tool '${tool.name}' from provider '${provider.providerName}'.`);
      tools.set(tool.name, tool);
    }
  }
  return { agentName, tools, providers };
}

export function composeInvocationSurface(agentName: AgentName, toolNames: readonly string[], providers: readonly ToolProvider[]): InvocationSurface {
  const definitions = new Map<string, { definition: ToolDefinition<any>; provider: ToolProvider }>();
  for (const provider of providers) {
    for (const definition of provider.tools) {
      if (definitions.has(definition.name)) throw new Error(`Duplicate tool '${definition.name}' from provider '${provider.providerName}'.`);
      definitions.set(definition.name, { definition, provider });
    }
  }

  const tools = new Map<string, ToolDefinition<any>>();
  const selectedByProvider = new Map<ToolProvider, ToolDefinition<any>[]>();
  for (const name of toolNames) {
    if (tools.has(name)) throw new Error(`Duplicate requested tool '${name}'.`);
    const selected = definitions.get(name);
    if (!selected) throw new Error(`Unknown requested tool '${name}'.`);
    tools.set(name, selected.definition);
    const providerTools = selectedByProvider.get(selected.provider) ?? [];
    providerTools.push(selected.definition);
    selectedByProvider.set(selected.provider, providerTools);
  }

  const selectedProviders = providers.flatMap((provider) => {
    const selectedTools = selectedByProvider.get(provider);
    if (!selectedTools) return [];
    return [{ providerName: provider.providerName, tools: Object.freeze(selectedTools), ...(provider.cleanup ? { cleanup: provider.cleanup.bind(provider) } : {}) } satisfies ToolProvider];
  });
  return { agentName, tools, providers: selectedProviders };
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
    rethrowAppLogPublicationError(error);
    if (error instanceof McpToolInvocationNotInstalledError) throw error;
    if (signal?.aborted && isRuntimeStoppedInterruption(signal.reason)) throw signal.reason;
    if (signal?.aborted) throw error;
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function invokeToolCall(surface: InvocationSurface, name: string, rawArgs: string, context: LlmToolInvocationContext, signal?: AbortSignal): Promise<ToolResult> {
  let args: unknown;
  try {
    args = JSON.parse(rawArgs) as unknown;
  } catch (error) {
    rethrowAppLogPublicationError(error);
    return { success: false, error: 'Tool arguments must be valid JSON.' };
  }
  return invokeToolForLlm(surface, name, args, context, signal);
}

export async function cleanupInvocationSurface(surface: InvocationSurface, reason: ToolProviderCleanupReason): Promise<void> {
  await Promise.all(surface.providers.map((provider) => provider.cleanup?.(reason)));
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' ? reason : 'Tool invocation was interrupted.');
}

export function llmToolDefinition(tool: ToolDefinition<any>): LlmToolDefinition {
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
