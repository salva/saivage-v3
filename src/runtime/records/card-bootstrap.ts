import type { CardService } from '../../cards/card-service.js';
import type { CardRecord } from '../../schemas/index.js';
export function cardBootstrapForPrompt(store: Pick<CardService, 'readRecord' | 'workflows'>, card: CardRecord): string {
  const workflow=store.workflows.cardTypes.get(card.type);
  if(!workflow)throw new Error(`No workflow is configured for card type '${card.type}'.`);
  return store.readRecord(card.id,workflow.bootstrapRecord.name,'latest').artifact.content;
}
