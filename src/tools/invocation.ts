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
}

export interface ToolProvider {
  readonly providerName: string;
  readonly tools: readonly ToolDefinition<any>[];
}

export interface InvocationSurface {
  readonly role: AgentRole;
  readonly tools: ReadonlyMap<string, ToolDefinition<any>>;
}

export function defineTool<Schema extends z.ZodTypeAny>(definition: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly executor: (args: z.infer<Schema>, signal: AbortSignal) => Promise<ToolResult>;
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
  return { role, tools };
}

export async function invokeTool(surface: InvocationSurface, name: string, args: unknown, signal: AbortSignal = new AbortController().signal): Promise<ToolResult> {
  const definition = surface.tools.get(name);
  if (!definition) return { success: false, error: `Unsupported tool '${name}' for role '${surface.role}'.` };
  const parsed = definition.inputSchema.safeParse(args);
  if (!parsed.success) return { success: false, error: parsed.error.message };
  if (signal.aborted) return { success: false, error: abortErrorMessage(signal) };
  return definition.executor(parsed.data, signal);
}

export async function invokeToolForLlm(surface: InvocationSurface, name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
  try {
    return await invokeTool(surface, name, args, signal);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function invokeToolCall(surface: InvocationSurface, name: string, rawArgs: string, signal?: AbortSignal): Promise<ToolResult> {
  let args: unknown;
  try {
    args = JSON.parse(rawArgs) as unknown;
  } catch {
    return { success: false, error: 'Tool arguments must be valid JSON.' };
  }
  return invokeTool(surface, name, args, signal);
}

function abortErrorMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return 'Tool invocation was interrupted.';
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
