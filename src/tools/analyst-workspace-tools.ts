import { z } from 'zod';

import type { UnifiedToolDefinition } from './analyst-tool-definition.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { describe, emptyInput } from './tool-definition.js';

export async function navigate_workspace(_ctx: ToolContext, params: { target: { kind: 'card' | 'transcript' | 'process' | 'process_list' | 'agent_session_list' | 'config'; id?: string; refinement?: string } }): Promise<ToolResult> {
  return { success: true, data: { intent: 'navigate_workspace', target: params.target } };
}

export async function navigate_back(_ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  return { success: true, data: { intent: 'navigate_back' } };
}

export const analystWorkspaceTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'navigate_workspace', description: 'Navigate the workspace area.', input: z.object({ target: z.object({ kind: z.enum(['card', 'transcript', 'process', 'process_list', 'agent_session_list', 'config']), id: describe(z.string().optional(), 'Optional target id.'), refinement: describe(z.string().optional(), 'Optional view refinement.') }).strict() }).strict(), roles: ['analyst'], executor: navigate_workspace },
  { name: 'navigate_back', description: 'Navigate back in the workspace area.', input: emptyInput, roles: ['analyst'], executor: navigate_back },
] as const;
