import { z } from 'zod';

import type { AgentRole } from '../schemas/index.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';

export type ToolExecutor<Input> = (ctx: ToolContext, params: Input) => Promise<ToolResult>;

export interface UnifiedToolDefinition<Name extends string = string, Input = unknown> {
  readonly name: Name;
  readonly description: string;
  readonly input: z.ZodType<Input>;
  readonly roles: readonly AgentRole[];
  readonly executor?: ToolExecutor<Input>;
  readonly plannerInput?: z.ZodTypeAny;
  readonly plannerDescription?: string;
  readonly workspace?: boolean;
  readonly skill?: boolean;
  readonly mcpWrapper?: boolean;
}
