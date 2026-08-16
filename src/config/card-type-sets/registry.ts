import { cardTypesSchema, type CardTypesSource, type CardTypeSetName, type SaivageConfigSource } from '../../schemas/index.js';
import { STANDARD_CARD_TYPE_SET } from './standard/index.js';

export interface CardTypeSetDefinition {
  readonly name: CardTypeSetName;
  readonly cardTypes: CardTypesSource;
}

export const DEFAULT_CARD_TYPE_SET = 'standard' satisfies CardTypeSetName;

export const BUNDLED_CARD_TYPE_SETS: readonly CardTypeSetDefinition[] = Object.freeze([
  STANDARD_CARD_TYPE_SET,
]);

export type ResolvedCardTypeSelection = Omit<SaivageConfigSource, 'card_type_set' | 'card_types'> & {
  readonly card_types: CardTypesSource;
};

export function resolveCardTypeSelection(
  source: SaivageConfigSource,
  definitions: readonly CardTypeSetDefinition[],
): ResolvedCardTypeSelection {
  const { card_type_set: selectedName, card_types: explicitCardTypes, ...globals } = source;
  if (explicitCardTypes !== undefined) {
    return { ...globals, card_types: cardTypesSchema.parse(structuredClone(explicitCardTypes)) };
  }

  const byName = new Map<CardTypeSetName, CardTypeSetDefinition>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) throw new Error(`Duplicate card type set '${definition.name}'.`);
    byName.set(definition.name, definition);
  }

  const name = selectedName ?? DEFAULT_CARD_TYPE_SET;
  const definition = byName.get(name);
  if (definition === undefined) {
    const error = new Error(`Unknown card_type_set '${name}'.`) as Error & { fieldPath?: string };
    error.fieldPath = 'card_type_set';
    throw error;
  }
  return { ...globals, card_types: cardTypesSchema.parse(structuredClone(definition.cardTypes)) };
}
