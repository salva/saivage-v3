import { z } from 'zod';

import { describe, type UnifiedToolDefinition } from './tool-catalog.js';

export const plannerControlTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'activate_card', description: 'Activate a card so runtime can proceed with the next planner-controlled step.', input: z.object({ card_id: describe(z.string(), 'The ID of the card to activate.') }).strict(), roles: ['planner'], plannerControl: true },
  { name: 'restart_card', description: 'Restart a terminal or changed card so it can be activated again.', input: z.object({ cardId: z.string() }).strict(), roles: ['planner'], plannerControl: true },
  { name: 'report_goal_done', description: 'Report a goal or project as done. Requires non-empty status_text and optional evidence_card_ids.', input: z.object({ status_text: z.string(), summary: z.string().optional(), evidence_card_ids: z.array(z.string()).optional(), report: z.record(z.unknown()).optional() }).strict(), roles: ['planner'], plannerControl: true },
  { name: 'report_goal_failed', description: 'Report a goal or project as failed. Requires non-empty status_text.', input: z.object({ status_text: z.string(), summary: z.string().optional(), evidence_card_ids: z.array(z.string()).optional(), report: z.record(z.unknown()).optional() }).strict(), roles: ['planner'], plannerControl: true },
  { name: 'report_goal_blocked', description: 'Report a goal or project as blocked. Requires non-empty status_text.', input: z.object({ status_text: z.string(), summary: z.string().optional(), evidence_card_ids: z.array(z.string()).optional(), report: z.record(z.unknown()).optional() }).strict(), roles: ['planner'], plannerControl: true },
] as const;
