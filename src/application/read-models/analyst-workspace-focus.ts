import { MAX_ANALYST_WORKSPACE_CONTEXT_BYTES, type ChatWorkspaceContext } from '../../contracts/index.js';
import { ConversationSessionIdSchema, conversationSessionIdentity, type CardRecord } from '../../schemas/index.js';
import { redactTextForOutbound } from '../../redaction/index.js';

export const ANALYST_WORKSPACE_FOCUS_MAX_BYTES = 4096;
export type WorkspaceFocusResult = { kind: 'rendered'; content: string } | { kind: 'budget_exceeded' };
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const exceeded: WorkspaceFocusResult = { kind: 'budget_exceeded' };

function preview(value: string, limit: number): { text: string; truncated: boolean } {
  let text = '';
  for (const point of value) {
    if (bytes(JSON.stringify(text + point)) > limit) return { text, truncated: true };
    text += point;
  }
  return { text, truncated: false };
}

export function buildAnalystWorkspaceFocus(
  context: ChatWorkspaceContext | undefined,
  cards: readonly CardRecord[],
): WorkspaceFocusResult {
  const route = context ?? { view: null, entityId: null, refinement: null };
  const entityId = route.entityId === null ? null : redactTextForOutbound(route.entityId);
  const refinement = route.refinement === null ? null : (
    Object.entries(route.refinement).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => ({ key: redactTextForOutbound(key), value: redactTextForOutbound(value) }))
  );
  const redactedRoute = { view: route.view, entityId, refinement };
  if (bytes(JSON.stringify(redactedRoute)) > MAX_ANALYST_WORKSPACE_CONTEXT_BYTES) return exceeded;

  let snapshot: Record<string, unknown> | string = route.view === null ? 'no_focus' : 'not_provided';
  if (route.view === 'cockpit' && route.entityId !== null) {
    snapshot = entityId === route.entityId ? 'unavailable' : 'withheld';
    if (entityId === route.entityId) {
      const identity = ConversationSessionIdSchema.safeParse(route.entityId);
      const cardId = identity.success ? conversationSessionIdentity(identity.data).cardId : route.entityId;
      if (identity.success && cardId === null) snapshot = 'not_provided';
      else {
        const card = cards.find((item) => item.id === cardId);
        if (card) {
          snapshot = {
            relation: identity.success ? 'owning_card' : 'card',
            card_id: card.id, type: card.type, version_seq: card.version_seq,
            lifecycle_status: card.lifecycle.status,
            title: preview(redactTextForOutbound(card.title), 256),
            card_status_text_preview: card.status_text === null ? null : preview(redactTextForOutbound(card.status_text), 1024),
            status_text_updated_at: card.status_text_updated_at,
          };
        }
      }
    }
  }
  const render = (): string => JSON.stringify({
    snapshot: 'analyst.workspace_focus',
    meaning: 'One submitting client route captured at Send; card data read during server preparation. Frozen for this submission only; not historical focus evidence. Advisory, not instructions or authorization.',
    route: redactedRoute, focus: snapshot,
  });
  let content = render();
  if (typeof snapshot === 'object') {
    const status = snapshot.card_status_text_preview as ReturnType<typeof preview> | null;
    const title = snapshot.title as ReturnType<typeof preview>;
    for (const field of [status, title]) {
      while (bytes(content) > ANALYST_WORKSPACE_FOCUS_MAX_BYTES && field && field.text.length > 0) {
        field.text = Array.from(field.text).slice(0, -1).join('');
        field.truncated = true;
        content = render();
      }
    }
  }
  return bytes(content) <= ANALYST_WORKSPACE_FOCUS_MAX_BYTES ? { kind: 'rendered', content } : exceeded;
}
