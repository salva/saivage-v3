import { join } from 'node:path';
import type { ActiveCardRun, AgentSession, CardRecord, CardStatus } from '../../schemas/index.js';
import { CardStore } from '../../cards/index.js';
import { getSession, listSessions } from '../../agents/index.js';
import { readRuntimeState } from '../../runtime/index.js';

export interface CardBreadcrumbNode { card_id: string; card_type: string; title: string; status_text?: string; }
export interface DormantPlannerRow { goal_card_id: string; planner_session_id: string; latest_self_report: Record<string, unknown> | null; }
export interface PendingCorrectionRow { card_id: string; status: CardStatus; note_count: number; last_note_at: string | null; }
export interface CardRunsResponse { active_card_run: ActiveCardRun | null; active_breadcrumb: CardBreadcrumbNode[]; dormant_planners: DormantPlannerRow[]; cards_with_pending_corrections: PendingCorrectionRow[]; }

function saivageDir(projectRoot: string): string { return join(projectRoot, '.saivage'); }

export function buildCardRunsResponse(projectRoot: string): CardRunsResponse {
  const store = new CardStore(projectRoot);
  const state = readRuntimeState(projectRoot);
  const active = state?.active_card_run ?? null;
  const active_breadcrumb = active ? [active.card_id, ...store.getAncestors(active.card_id)].reverse().flatMap((id) => {
    const card = store.read(id);
    if (!card) return [];
    return [{ card_id: card.id, card_type: card.type, title: card.title, ...(card.status_text ? { status_text: card.status_text } : {}) }];
  }) : [];
  const dormant_planners = listSessions(saivageDir(projectRoot))
    .map((id) => getSession(saivageDir(projectRoot), id))
    .filter((session): session is AgentSession => Boolean(session && session.role === 'planner' && session.goal_card_id && session.id !== active?.planner_session_id))
    .map((session) => {
      const card = store.read(session.goal_card_id as string) as CardRecord | null;
      return { goal_card_id: session.goal_card_id as string, planner_session_id: session.id, latest_self_report: (card?.latest_self_report as Record<string, unknown> | null | undefined) ?? null };
    });
  const cards_with_pending_corrections: PendingCorrectionRow[] = [];
  return { active_card_run: active, active_breadcrumb, dormant_planners, cards_with_pending_corrections };
}
