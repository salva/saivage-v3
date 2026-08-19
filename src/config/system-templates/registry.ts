import { effectiveSaivageConfigSchema, saivageConfigSchema, type SaivageConfig, type SaivageConfigSource, type SystemTemplateName } from '../../schemas/index.js';
import { CLASSIC_TEMPLATE } from './classic/template.js';
import { CLASSIC_TYPED_TEMPLATE } from './classic-typed/template.js';

export interface SystemTemplateDefinition {
  readonly name: SystemTemplateName;
  readonly config: SaivageConfigSource;
  readonly promptRoot: string;
}

export const SYSTEM_TEMPLATES: readonly SystemTemplateDefinition[] = Object.freeze([CLASSIC_TEMPLATE, CLASSIC_TYPED_TEMPLATE]);

export const DEFAULT_SYSTEM_TEMPLATE = 'classic' satisfies SystemTemplateName;

export function validateSystemTemplates(templates: readonly SystemTemplateDefinition[]): void {
  const seenNames = new Set<SystemTemplateName>();
  for (const template of templates) {
    if (template.name.length === 0 || seenNames.has(template.name)) throw new Error(`Duplicate or empty system template '${template.name}'.`);
    seenNames.add(template.name);
    saivageConfigSchema.parse(template.config);
  }
}

validateSystemTemplates(SYSTEM_TEMPLATES);

export function resolveSystemTemplate(name: string): SystemTemplateDefinition {
  const template = SYSTEM_TEMPLATES.find((candidate) => candidate.name === name);
  if (template === undefined) {
    const error = new Error(`Unknown template '${name}'. Available templates: ${SYSTEM_TEMPLATES.map((candidate) => candidate.name).join(', ')}.`) as Error & { fieldPath?: string };
    error.fieldPath = 'profile';
    throw error;
  }
  return template;
}

export const DEFAULT_SAIVAGE_CONFIG: SaivageConfig = Object.freeze(effectiveSaivageConfigSchema.parse(structuredClone(resolveSystemTemplate(DEFAULT_SYSTEM_TEMPLATE).config)));
