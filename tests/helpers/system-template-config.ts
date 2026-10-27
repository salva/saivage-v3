import { SYSTEM_TEMPLATES, materializeSystemTemplate, type RegisteredSystemTemplate, type SystemTemplateDefinition } from '../../src/config/system-templates/registry.js';

export const syntheticGitProvisioning = {
  delivery_branch: 'fixture-delivery', private_ref_namespace: 'refs/saivage/fixture',
  source_roots: ['.'], excluded_paths: ['.git', '.saivage'],
};
export function templateConfig(template: RegisteredSystemTemplate) {
  return materializeSystemTemplate(template, 'provisioning' in template ? syntheticGitProvisioning : undefined);
}
export const OFF_SYSTEM_TEMPLATES = SYSTEM_TEMPLATES.filter((template): template is SystemTemplateDefinition => !('provisioning' in template));
