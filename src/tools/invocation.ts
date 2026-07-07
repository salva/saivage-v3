import { z } from 'zod';

import type { ToolDefinition as LlmToolDefinition } from '../agents/llm-contracts.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import type { AgentRole } from '../schemas/index.js';

export type ToolResult =
  | { success: true; data?: unknown; error?: never }
  | { success: false; error: string; data?: unknown };

export interface ToolDefinition<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
  readonly executor: (args: Args, signal: AbortSignal) => Promise<ToolResult>;
  readonly replay?: (args: Args) => Promise<ToolReplayOutcome>;
}

export type ToolReplayOutcome =
  | { kind: 'settled'; result: ToolResult }
  | { kind: 'redispatch' };

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
  readonly role: AgentRole;
  readonly tools: ReadonlyMap<string, ToolDefinition<any>>;
  readonly providers: readonly ToolProvider[];
}

export function defineTool<Schema extends z.ZodTypeAny>(definition: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly executor: (args: z.infer<Schema>, signal: AbortSignal) => Promise<ToolResult>;
  readonly replay?: (args: z.infer<Schema>) => Promise<ToolReplayOutcome>;
}): ToolDefinition<z.infer<Schema>> {
  return definition;
}

export function buildInvocationSurface(role: AgentRole, providers: readonly ToolProvider[]): InvocationSurface {
  const tools = new Map<string, ToolDefinition<any>>();
  for (const provider of providers) {
    for (const tool of provider.tools) {
      if (tools.has(tool.name)) throw new Error(`Duplicate tool '${tool.name}' from provider '${provider.providerName}'.`);
      tools.set(tool.name, tool);
    }
  }
  return { role, tools, providers };
}

export async function invokeTool(surface: InvocationSurface, name: string, args: unknown, signal: AbortSignal = new AbortController().signal): Promise<ToolResult> {
  if (signal.aborted) throw abortError(signal);
  const definition = surface.tools.get(name);
  if (!definition) return { success: false, error: `Unsupported tool '${name}' for role '${surface.role}'.` };
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) return { success: false, error: parsed.error.message };
  if (signal.aborted) throw abortError(signal);
  return definition.executor(parsed.data, signal);
}

export async function invokeToolForLlm(surface: InvocationSurface, name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
  try {
    return await invokeTool(surface, name, args, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function replayToolForRecovery(surface: InvocationSurface, name: string, args: unknown): Promise<ToolReplayOutcome> {
  const definition = surface.tools.get(name);
  if (!definition) return { kind: 'settled', result: defaultInterruptedToolResult(name) };
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) return { kind: 'settled', result: { success: false, error: parsed.error.message } };
  return definition.replay?.(parsed.data) ?? { kind: 'settled', result: defaultInterruptedToolResult(name) };
}

function defaultInterruptedToolResult(toolName: string): ToolResult {
  return { success: false, error: `Runtime restarted before '${toolName}' completed. Re-issue the call after inspecting current state.` };
}

export async function invokeToolCall(surface: InvocationSurface, name: string, rawArgs: string, signal?: AbortSignal): Promise<ToolResult> {
  let args: unknown;
  try {
    args = JSON.parse(rawArgs) as unknown;
  } catch {
    return { success: false, error: 'Tool arguments must be valid JSON.' };
  }
  return invokeToolForLlm(surface, name, args, signal);
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
