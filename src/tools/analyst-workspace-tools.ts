import { z } from 'zod';

import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { describe, emptyInput, type UnifiedToolDefinition } from './tool-definition.js';

export async function navigate_workspace(ctx: ToolContext, params: { target: { kind: 'card' | 'transcript' | 'process' | 'process_list' | 'agent_session_list' | 'config'; id?: string; refinement?: string } }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'workspace.navigate', safety_class: 'low', target_kind: 'session', getTargetId: (p) => `${p.target.kind}:${p.target.id ?? '-'}`, run: async () => ({ success: true, data: { intent: 'navigate_workspace', target: params.target } }) });
}

export async function navigate_back(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'workspace.navigate_back', safety_class: 'low', target_kind: 'session', getTargetId: () => 'workspace', run: async () => ({ success: true, data: { intent: 'navigate_back' } }) });
}

export const analystWorkspaceTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'navigate_workspace', description: 'Navigate the workspace area.', input: z.object({ target: z.object({ kind: z.enum(['card', 'transcript', 'process', 'process_list', 'agent_session_list', 'config']), id: describe(z.string().optional(), 'Optional target id.'), refinement: describe(z.string().optional(), 'Optional view refinement.') }).strict() }).strict(), roles: ['analyst'], executor: navigate_workspace },
  { name: 'navigate_back', description: 'Navigate back in the workspace area.', input: emptyInput, roles: ['analyst'], executor: navigate_back },
] as const;
