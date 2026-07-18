import type { CardRecord, CardStatus } from '../../schemas/index.js';
import type { CardService } from '../../cards/card-api.js';
import type { RuntimeApi } from '../../runtime/runtime-api.js';
import { listConversationSessionIds } from '../../runtime/actors/conversation-session.js';

export interface CardBreadcrumbNode { card_id: string; card_type: string; title: string; status_text?: string; }
export interface DormantPlannerRow { goal_card_id: string; planner_session_id: string; latest_self_report: Record<string, unknown> | null; }
export interface PendingCorrectionRow { card_id: string; status: CardStatus; note_count: number; last_note_at: string | null; }
export interface CardRunsResponse { current_card_id: string | null; active_breadcrumb: CardBreadcrumbNode[]; dormant_planners: DormantPlannerRow[]; cards_with_pending_corrections: PendingCorrectionRow[]; }

function plannerGoalFromSessionId(sessionId: string): string | null {
  return sessionId.startsWith('planner:') ? sessionId.slice('planner:'.length) : null;
}

export function buildCardRunsResponse(projectRoot: string, store: CardService, runtime: Pick<RuntimeApi, 'getRuntimeState'>): CardRunsResponse {
  const state = runtime.getRuntimeState();
  const currentCardId = state?.current_card_id ?? null;
  const active_breadcrumb = currentCardId ? [currentCardId, ...store.getAncestors(currentCardId)].reverse().flatMap((id) => {
    const card = store.read(id);
    if (!card) return [];
    return [{ card_id: card.id, card_type: card.type, title: card.title, ...(card.status_text ? { status_text: card.status_text } : {}) }];
  }) : [];
  const dormant_planners = listConversationSessionIds(projectRoot)
    .flatMap((sessionId) => {
      const goalId = plannerGoalFromSessionId(sessionId);
      if (!goalId) return [];
      const card = store.read(goalId) as CardRecord | null;
      return [{ goal_card_id: goalId, planner_session_id: sessionId, latest_self_report: (card?.latest_self_report as Record<string, unknown> | null | undefined) ?? null }];
    });
  const cards_with_pending_corrections: PendingCorrectionRow[] = [];
  return { current_card_id: currentCardId, active_breadcrumb, dormant_planners, cards_with_pending_corrections };
}
