import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { emptyInput } from './tool-definition.js';
import { defineTool, type ToolDefinition } from './invocation.js';
import { navigateWorkspaceInputSchema } from '../contracts/builtin-tool-inputs.js';

export async function navigate_workspace(_ctx: ToolContext, params: { target: { kind: 'card' | 'transcript' | 'process' | 'process_list' | 'agent_session_list' | 'config'; id?: string; refinement?: string } }): Promise<ToolResult> {
  return { success: true, data: { intent: 'navigate_workspace', target: params.target } };
}

export async function navigate_back(_ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  return { success: true, data: { intent: 'navigate_back' } };
}

export function analystWorkspaceTools(ctx: ToolContext): readonly ToolDefinition<any>[] { return [
  defineTool({ name: 'navigate_workspace', description: 'Navigate the workspace area.', inputSchema: navigateWorkspaceInputSchema, executor: (args) => navigate_workspace(ctx, args) }),
  defineTool({ name: 'navigate_back', description: 'Navigate back in the workspace area.', inputSchema: emptyInput, executor: (args) => navigate_back(ctx, args) }),
]; }
