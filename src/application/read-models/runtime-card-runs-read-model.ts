import type { CardService } from '../../cards/card-api.js';
import {
  RuntimeCardRunsResponseSchema,
  type RuntimeCardRunsResponse,
} from '../../contracts/index.js';
import type { RuntimeApi } from '../../runtime/runtime-api.js';
import { AgentOperatorReadModelService } from './agent-operator-read-model.js';
import { redactForOutbound } from '../../redaction/index.js';
import { conversationSessionIdentity } from '../../schemas/index.js';

export function buildCardRunsResponse(
  projectRoot: string,
  store: CardService,
  runtime: Pick<RuntimeApi, 'getRuntimeState'>,
): RuntimeCardRunsResponse {
  const state = runtime.getRuntimeState();
  const currentCardId = state?.current_card_id ?? null;
  const active_breadcrumb = currentCardId
    ? [currentCardId, ...store.getAncestors(currentCardId)].reverse().flatMap((id) => {
        const card = store.read(id);
        if (!card) return [];
        return [
          {
            card_id: card.id,
            card_type: card.type,
            title: card.title,
            ...(card.status_text ? { status_text: card.status_text } : {}),
          },
        ];
      })
    : [];
  const dormant_agents = new AgentOperatorReadModelService(projectRoot, store.workflows)
    .listSessions()
    .sessions.flatMap(({ id: sessionId }) => {
      const identity = conversationSessionIdentity(sessionId);
      if (!identity.cardId) return [];
      return [{ card_id: identity.cardId, agent_name: identity.agentName, session_id: sessionId }];
    });
  const response = RuntimeCardRunsResponseSchema.parse({
    current_card_id: currentCardId,
    active_breadcrumb,
    dormant_agents,
  });
  return RuntimeCardRunsResponseSchema.parse(
    redactForOutbound({ source: 'runtime-card-runs', value: response }),
  );
}
