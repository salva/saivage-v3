import { z } from 'zod';

import type { CardStore } from '../cards/store-api.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { navigate_back, navigate_workspace } from './analyst-workspace-tools.js';
import { defineTool, type ToolProvider, type ToolResult as InvocationToolResult } from './invocation.js';

export interface WorkspaceNavigationProviderContext {
  readonly projectRoot: string;
  readonly store: CardStore;
  readonly sessionId?: string;
}

const navigateWorkspaceSchema = z.object({ target: z.object({ kind: z.enum(['card', 'transcript', 'process', 'process_list', 'agent_session_list', 'config']), id: z.string().optional(), refinement: z.string().optional() }).strict() }).strict();
const navigateBackSchema = z.object({}).strict();

function toolContext(ctx: WorkspaceNavigationProviderContext): ToolContext {
  return { projectRoot: ctx.projectRoot, store: ctx.store, sessionId: ctx.sessionId, actor: 'analyst', surface: 'web-chat' };
}

function invocationResult(result: ToolResult): InvocationToolResult {
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: result.error ?? result.errorEnvelope?.message ?? 'Tool failed.' };
}

export function createWorkspaceNavigationProvider(ctx: WorkspaceNavigationProviderContext): ToolProvider {
  return {
    providerName: 'workspace-navigation',
    tools: [
      defineTool({
        name: 'navigate_workspace',
        description: 'Navigate the workspace area.',
        inputSchema: navigateWorkspaceSchema,
        executor: async (args) => invocationResult(await navigate_workspace(toolContext(ctx), args)),
      }),
      defineTool({
        name: 'navigate_back',
        description: 'Navigate back in the workspace area.',
        inputSchema: navigateBackSchema,
        executor: async (args) => invocationResult(await navigate_back(toolContext(ctx), args)),
      }),
    ],
  };
}
