import type { AnalystToolOutcome, ToolContext } from './analyst-tool-types.js';
import { emptyInput } from './tool-definition.js';
import { defineToolBinder, executeToolAction, OPERATIONAL_RESULT_POLICY_TEMPLATE, type ToolBinder } from './invocation.js';
import { navigateWorkspaceInputSchema, type NavigateWorkspaceInput } from '../contracts/builtin-tool-inputs.js';
import type { WorkspaceNavigationIntent } from '../contracts/workspace-navigation.js';
import { toolSucceeded } from '../contracts/tool-result.js';

async function navigate_workspace(_ctx: ToolContext, params: NavigateWorkspaceInput): Promise<AnalystToolOutcome> {
  const data = { intent: 'navigate_workspace', target: params.target } satisfies WorkspaceNavigationIntent;
  return toolSucceeded(data);
}

async function navigate_back(_ctx: ToolContext, _params: Record<string, never> = {}): Promise<AnalystToolOutcome> {
  const data = { intent: 'navigate_back' } satisfies WorkspaceNavigationIntent;
  return toolSucceeded(data);
}

export const analystNavigationToolBinders: readonly ToolBinder<ToolContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'navigate_workspace', description: 'Navigate the workspace area.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => navigateWorkspaceInputSchema, executor: (ctx, args) => executeToolAction('none', () => navigate_workspace(ctx, args)) }),
  defineToolBinder({ name: 'navigate_back', description: 'Navigate back in the workspace area.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => emptyInput, executor: (ctx, args) => executeToolAction('none', () => navigate_back(ctx, args)) }),
]);
