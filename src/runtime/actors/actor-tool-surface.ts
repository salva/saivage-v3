import type { ToolDefinition } from '../../agents/llm-contracts.js';

export interface ActorToolHandlerContext {
  projectRoot: string;
  cardId: string;
  sessionId: string;
}

export interface ActorToolHandler {
  name: string;
  definition: ToolDefinition;
  execute(args: unknown, context: ActorToolHandlerContext): Promise<unknown> | unknown;
}

export class ActorToolSurface {
  readonly #handlers: Map<string, ActorToolHandler>;

  constructor(handlers: ActorToolHandler[]) {
    this.#handlers = new Map(handlers.map((handler) => [handler.name, handler]));
    if (this.#handlers.size !== handlers.length) throw new Error('ActorToolSurface handler names must be unique.');
  }

  definitions(): ToolDefinition[] {
    return [...this.#handlers.values()].map((handler) => handler.definition);
  }

  handles(toolName: string): boolean {
    return this.#handlers.has(toolName);
  }

  async execute(toolName: string, args: unknown, context: ActorToolHandlerContext): Promise<unknown> {
    const handler = this.#handlers.get(toolName);
    if (!handler) throw new Error(`Unsupported actor tool call '${toolName}'.`);
    return handler.execute(args, context);
  }
}
