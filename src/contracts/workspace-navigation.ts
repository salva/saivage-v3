import { z } from 'zod';

export const workspaceNavigationTargetSchema = z.object({
  kind: z.enum(['card', 'transcript', 'process', 'process_list', 'agent_session_list', 'config']),
  id: z.string().optional().describe('Optional target id.'),
  refinement: z.string().optional().describe('Optional view refinement.'),
}).strict();

export const workspaceNavigationIntentSchema = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('navigate_workspace'),
    target: workspaceNavigationTargetSchema,
  }).strict(),
  z.object({
    intent: z.literal('navigate_back'),
  }).strict(),
]);

export type WorkspaceNavigationTarget = z.infer<typeof workspaceNavigationTargetSchema>;
export type WorkspaceNavigationIntent = z.infer<typeof workspaceNavigationIntentSchema>;
