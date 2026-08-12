import type { CardService } from '../../cards/card-service.js';
import type { CardRecord } from '../../schemas/index.js';
export function cardBootstrapForPrompt(store: Pick<CardService, 'readCurrentRecord' | 'workflows'>, card: CardRecord): string {
  const workflow=store.workflows.cardTypes.get(card.type);
  if(!workflow)throw new Error(`No workflow is configured for card type '${card.type}'.`);
  const accepted=store.readCurrentRecord(card.id,workflow.bootstrapRecord.name).artifact.accepted;if(!accepted)throw new Error(`Bootstrap record '${card.id}/${workflow.bootstrapRecord.name}' has no accepted content.`);return accepted.content;
}
