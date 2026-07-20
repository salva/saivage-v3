import type { CardService } from '../../cards/card-api.js';
import type { RuntimeCardRunsResponse } from '../../contracts/index.js';
import type { RuntimeApi } from '../../runtime/runtime-api.js';
import { listConversationSessionIds } from '../../persistence/conversation-file.js';

function plannerGoalFromSessionId(sessionId: string): string | null {
  return sessionId.startsWith('planner:') ? sessionId.slice('planner:'.length) : null;
}

export function buildCardRunsResponse(projectRoot: string, store: CardService, runtime: Pick<RuntimeApi, 'getRuntimeState'>): RuntimeCardRunsResponse {
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
      const card = store.read(goalId);
      return [{ goal_card_id: goalId, planner_session_id: sessionId, latest_self_report: card?.latest_self_report ?? null }];
    });
  return { current_card_id: currentCardId, active_breadcrumb, dormant_planners };
}
