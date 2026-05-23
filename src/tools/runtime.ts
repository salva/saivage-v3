import type { z } from 'zod';
import type { EventEmitter } from 'node:events';

import type { CardAction, CardState, Decision, PermissionRole } from '../permissions/card-permissions.js';
import type { ResourceScope } from '../lifecycle/resource-scope.js';

export type JsonSchemaObject = { type: 'object'; properties?: { [key: string]: unknown }; required?: string[]; additionalProperties?: boolean };

export interface ToolContext {
  projectRoot: string;
  sessionId?: string;
  role: PermissionRole;
  surface: 'runtime';
  scope?: ResourceScope;
  bus?: EventEmitter;
}

export interface ToolRegistrySchemaEntry<Name extends string = string> {
  type: 'function';
  function: {
    name: Name;
    description: string;
    parameters: JsonSchemaObject;
  };
  roles: readonly PermissionRole[];
  action?: CardAction;
}

export interface ToolRuntimeDependencies {
  matrix: { decide(input: { role: PermissionRole; action: CardAction; targetState: CardState }): Decision };
  scope?: ResourceScope;
  bus?: EventEmitter;
}

export type ToolRuntimeErrorKind = 'ToolInputRejected' | 'ToolRoleRejected' | 'ToolStateRejected' | 'ToolContractViolation' | 'ToolExecutionError' | 'ToolUnknown';

export interface ToolRuntimeError {
  kind: ToolRuntimeErrorKind;
  message: string;
  details?: unknown;
}

export type ToolResult<Output> =
  | { ok: true; output: Output }
  | { ok: false; error: ToolRuntimeError };

export interface ToolInvocation<Name extends string = string> {
  name: Name;
  input: unknown;
  role: PermissionRole;
  correlationId: string;
  projectRoot: string;
  sessionId?: string;
  targetState?: CardState;
}

export interface ToolDefinition<Name extends string, Input, Output> {
  readonly name: Name;
  readonly description: string;
  readonly input: z.ZodType<Input>;
  readonly output: z.ZodType<Output>;
  readonly parameters: JsonSchemaObject;
  readonly roles: readonly PermissionRole[];
  readonly action?: CardAction;
  readonly targetState: (input: Input, invocation: ToolInvocation) => CardState | undefined;
  execute(ctx: ToolContext, input: Input): Promise<Output>;
}

export function defineTool<Name extends string, Input, Output>(definition: ToolDefinition<Name, Input, Output>): ToolDefinition<Name, Input, Output> {
  return definition;
}

type AnyToolDefinition = ToolDefinition<string, any, any>;

export class ToolRuntime<Definitions extends readonly ToolDefinition<string, any, any>[]> {
  private readonly definitions: Map<string, AnyToolDefinition>;

  constructor(private readonly deps: ToolRuntimeDependencies, definitions: Definitions) {
    this.definitions = new Map(definitions.map((definition) => [definition.name, definition]));
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  schema(): ToolRegistrySchemaEntry[] {
    return [...this.definitions.values()].map((definition) => ({
      type: 'function',
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      },
      roles: definition.roles,
      action: definition.action,
    }));
  }

  toolNamesForRole(role: PermissionRole): string[] {
    return [...this.definitions.values()].filter((definition) => definition.roles.includes(role)).map((definition) => definition.name);
  }

  async invoke(invocation: ToolInvocation): Promise<ToolResult<unknown>> {
    const definition = this.definitions.get(invocation.name);
    if (!definition) return this.reject('ToolUnknown', `Unknown tool '${invocation.name}'.`);

    const parsedInput = definition.input.safeParse(invocation.input);
    if (!parsedInput.success) {
      return this.reject('ToolInputRejected', `Invalid input for tool '${definition.name}'.`, parsedInput.error.flatten());
    }

    if (!definition.roles.includes(invocation.role)) {
      return this.reject('ToolRoleRejected', `Role '${invocation.role}' is not permitted to invoke '${definition.name}'.`);
    }

    const targetState = invocation.targetState ?? definition.targetState(parsedInput.data, invocation);
    if (definition.action) {
      if (!targetState) return this.reject('ToolStateRejected', `Tool '${definition.name}' requires a target card state for '${definition.action}'.`);
      const decision = this.deps.matrix.decide({ role: invocation.role, action: definition.action, targetState });
      if (!decision.allowed) {
        return this.reject('ToolStateRejected', `Tool '${definition.name}' denied by permission matrix for state '${targetState}' (${decision.reason}).`, { action: definition.action, targetState, reason: decision.reason });
      }
    }

    this.deps.bus?.emit('tool_invoked', { tool: definition.name, role: invocation.role, correlation_id: invocation.correlationId });
    try {
      const output = await definition.execute({
        projectRoot: invocation.projectRoot,
        sessionId: invocation.sessionId,
        role: invocation.role,
        surface: 'runtime',
        scope: this.deps.scope?.child(`tool:${definition.name}:${invocation.correlationId}`),
        bus: this.deps.bus,
      }, parsedInput.data);
      const parsedOutput = definition.output.safeParse(output);
      if (!parsedOutput.success) {
        const error = { kind: 'ToolContractViolation' as const, message: `Tool '${definition.name}' returned output that does not match its contract.`, details: parsedOutput.error.flatten() };
        this.deps.bus?.emit('runtime_actionable_error', { code: error.kind, message: error.message, correlation_id: invocation.correlationId });
        this.deps.bus?.emit('tool_failed', { tool: definition.name, role: invocation.role, correlation_id: invocation.correlationId, error: error.message });
        return { ok: false, error };
      }
      this.deps.bus?.emit('tool_succeeded', { tool: definition.name, role: invocation.role, correlation_id: invocation.correlationId });
      return { ok: true, output: parsedOutput.data };
    } catch (error) {
      const wrapped = { kind: 'ToolExecutionError' as const, message: error instanceof Error ? error.message : String(error) };
      this.deps.bus?.emit('tool_failed', { tool: definition.name, role: invocation.role, correlation_id: invocation.correlationId, error: wrapped.message });
      return { ok: false, error: wrapped };
    }
  }

  private reject(kind: ToolRuntimeErrorKind, message: string, details?: unknown): ToolResult<never> {
    return { ok: false, error: { kind, message, details } };
  }
}
