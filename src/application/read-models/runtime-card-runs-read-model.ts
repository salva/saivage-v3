import type { CardService } from '../../cards/card-api.js';
import { RuntimeCardRunsResponseSchema, type RuntimeCardRunsResponse } from '../../contracts/index.js';
import type { RuntimeApi } from '../../runtime/runtime-api.js';
import { readConversationInventory } from '../../persistence/conversation-file.js';
import { redactForOutbound } from '../../redaction/index.js';

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
  const dormant_planners = readConversationInventory(projectRoot)
    .flatMap(({ sessionId }) => {
      const goalId = plannerGoalFromSessionId(sessionId);
      if (!goalId) return [];
      return [{ goal_card_id: goalId, planner_session_id: sessionId }];
    });
  const response = RuntimeCardRunsResponseSchema.parse({ current_card_id: currentCardId, active_breadcrumb, dormant_planners });
  return RuntimeCardRunsResponseSchema.parse(redactForOutbound({ source: 'runtime-card-runs', value: response }));
}
