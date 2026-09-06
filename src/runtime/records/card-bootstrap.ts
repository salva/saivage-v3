import type { CardService } from '../../cards/card-service.js';
import type { CardRecord } from '../../schemas/index.js';
export function cardBootstrapForPrompt(store: Pick<CardService, 'readRecordCurrent' | 'workflows'>, card: CardRecord): string {
  const workflow=store.workflows.cardTypes.get(card.type);
  if(!workflow)throw new Error(`No workflow is configured for card type '${card.type}'.`);
  const result=store.readRecordCurrent(card.id,workflow.bootstrapRecord.name);if(result.kind==='card-not-found'||!result.value.projection)throw new Error(`Bootstrap record '${card.id}/${workflow.bootstrapRecord.name}' is unavailable.`);const accepted=result.value.projection.artifact.accepted;if(!accepted)throw new Error(`Bootstrap record '${card.id}/${workflow.bootstrapRecord.name}' has no accepted content.`);return accepted.content;
}
