import { effectiveSaivageConfigSchema, type CardTypesSource, type SaivageConfig } from '../../src/schemas/saivage-config.js';
import { DEFAULT_SAIVAGE_CONFIG, resolveSystemTemplate } from '../../src/config/system-templates/registry.js';

export function specializedCardTypes(): CardTypesSource {
  const cardTypes = structuredClone(resolveSystemTemplate('classic-typed').config.card_types);
  if (cardTypes === undefined) throw new Error('classic-typed template config has no card_types.');
  return cardTypes;
}

export function specializedConfig(): SaivageConfig {
  const { card_types: _cardTypes, ...globals } = structuredClone(DEFAULT_SAIVAGE_CONFIG);
  return effectiveSaivageConfigSchema.parse({ ...globals, card_types: specializedCardTypes() });
}
