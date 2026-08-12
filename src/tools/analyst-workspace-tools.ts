import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { emptyInput } from './tool-definition.js';
import { defineToolBinder, type ToolBinder } from './invocation.js';
import { navigateWorkspaceInputSchema, type NavigateWorkspaceInput } from '../contracts/builtin-tool-inputs.js';
import type { WorkspaceNavigationIntent } from '../contracts/workspace-navigation.js';

export async function navigate_workspace(_ctx: ToolContext, params: NavigateWorkspaceInput): Promise<ToolResult> {
  const data = { intent: 'navigate_workspace', target: params.target } satisfies WorkspaceNavigationIntent;
  return { success: true, data };
}

export async function navigate_back(_ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  const data = { intent: 'navigate_back' } satisfies WorkspaceNavigationIntent;
  return { success: true, data };
}

export const analystNavigationToolBinders: readonly ToolBinder<ToolContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'navigate_workspace', description: 'Navigate the workspace area.', inputSchema: navigateWorkspaceInputSchema, executor: (ctx, args) => navigate_workspace(ctx, args) }),
  defineToolBinder({ name: 'navigate_back', description: 'Navigate back in the workspace area.', inputSchema: emptyInput, executor: (ctx, args) => navigate_back(ctx, args) }),
]);
