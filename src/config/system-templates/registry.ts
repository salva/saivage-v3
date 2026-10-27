import {
  effectiveSaivageConfigSchema,
  saivageConfigSchema,
  type SaivageConfig,
  type SaivageConfigSource,
  type SystemTemplateName,
} from '../../schemas/index.js';
import { CLASSIC_TEMPLATE } from './classic/template.js';
import { CLASSIC_TYPED_TEMPLATE } from './classic-typed/template.js';
import { PAAD_TYPED_TEMPLATE } from './paad-typed/template.js';
import { CLASSIC_GIT_TEMPLATE, type GitProvisioning } from './classic-git/template.js';

export interface SystemTemplateDefinition {
  readonly name: SystemTemplateName;
  readonly config: SaivageConfigSource;
  readonly promptRoot: string;
}

export type RegisteredSystemTemplate = SystemTemplateDefinition | typeof CLASSIC_GIT_TEMPLATE;

export function materializeSystemTemplate(template: RegisteredSystemTemplate, provisioning?: GitProvisioning): SaivageConfigSource {
  if ('provisioning' in template) {
    if (!provisioning) throw new Error('classic-git requires all four --git-* provisioning options.');
    return template.materialize(provisioning);
  }
  if (provisioning) throw new Error('Native provisioning options cannot select an OFF profile.');
  return structuredClone(template.config);
}

export const SYSTEM_TEMPLATES: readonly RegisteredSystemTemplate[] = Object.freeze([
  CLASSIC_TEMPLATE,
  CLASSIC_TYPED_TEMPLATE,
  PAAD_TYPED_TEMPLATE,
  CLASSIC_GIT_TEMPLATE,
]);

export const DEFAULT_SYSTEM_TEMPLATE = 'classic' satisfies SystemTemplateName;

export function validateSystemTemplates(templates: readonly RegisteredSystemTemplate[]): void {
  const seenNames = new Set<SystemTemplateName>();
  for (const template of templates) {
    if (template.name.length === 0 || seenNames.has(template.name))
      throw new Error(`Duplicate or empty system template '${template.name}'.`);
    seenNames.add(template.name);
    if (!('provisioning' in template)) saivageConfigSchema.parse(template.config);
  }
}

validateSystemTemplates(SYSTEM_TEMPLATES);

export function resolveSystemTemplate(name: 'classic' | 'classic-typed' | 'paad-typed'): SystemTemplateDefinition;
export function resolveSystemTemplate(name: string): RegisteredSystemTemplate;
export function resolveSystemTemplate(name: string): RegisteredSystemTemplate {
  const template = SYSTEM_TEMPLATES.find((candidate) => candidate.name === name);
  if (template === undefined) {
    const error = new Error(
      `Unknown template '${name}'. Available templates: ${SYSTEM_TEMPLATES.map((candidate) => candidate.name).join(', ')}.`,
    ) as Error & { fieldPath?: string };
    error.fieldPath = 'profile';
    throw error;
  }
  return template;
}

export const DEFAULT_SAIVAGE_CONFIG: SaivageConfig = Object.freeze(
  effectiveSaivageConfigSchema.parse(
    structuredClone(resolveSystemTemplate(DEFAULT_SYSTEM_TEMPLATE).config),
  ),
);
