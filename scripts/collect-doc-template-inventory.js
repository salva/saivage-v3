#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_TEMPLATES, DEFAULT_SYSTEM_TEMPLATE, materializeSystemTemplate } from '../src/config/system-templates/registry.js';
import { saivageConfigSchema, effectiveSaivageConfigSchema } from '../src/schemas/saivage-config.js';
import { SYNTHETIC_GIT_PROVISIONING } from './system-template-fixtures.js';

function assertJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || seen.has(value)
    || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
    throw new Error('Non-JSON configuration value');
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('Non-JSON configuration property');
    }
    assertJson(descriptor.value, seen);
  }
  seen.delete(value);
}

function collect() {
  const names = new Set();
  const templates = SYSTEM_TEMPLATES.map((template) => {
    if (typeof template.name !== 'string' || !template.name || names.has(template.name)) {
      throw new Error('Invalid registry identity');
    }
    names.add(template.name);
    try {
      const provisioningRequired = 'provisioning' in template;
      if (!provisioningRequired && !Object.isFrozen(template.config)) throw new Error('Unfrozen factory configuration');
      const source = materializeSystemTemplate(template,
        provisioningRequired ? SYNTHETIC_GIT_PROVISIONING : undefined);
      assertJson(source);
      saivageConfigSchema.parse(source);
      const config = effectiveSaivageConfigSchema.parse(source);
      const agents = Object.entries(config.agents).map(([name, agent]) => {
        const tools = agent.capabilities.grants.flatMap((grant) => grant.tools);
        if (new Set(tools).size !== tools.length) throw new Error(`Duplicate tools for ${name}`);
        return { name, tools };
      });
      return { name: template.name, provisioningRequired, agents };
    } catch (error) {
      // Report schema locations/codes, never configuration values or error messages.
      const issues = error?.issues;
      const detail = Array.isArray(issues)
        ? issues.map((issue) => `${issue.path.join('.')}:${issue.code}`).join(', ')
        : 'invalid materialization/inventory';
      throw new Error(`Template '${template.name}' validation failed (${detail})`);
    }
  });
  if (!names.has(DEFAULT_SYSTEM_TEMPLATE)) throw new Error('Unregistered default template');
  return { defaultTemplate: DEFAULT_SYSTEM_TEMPLATE, templates };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Unexpected observer arguments');
    process.stdout.write(JSON.stringify(collect()));
  } catch (error) {
    process.stderr.write(`${error instanceof Error && error.message.startsWith('Template ')
      ? error.message : 'Emitted template inventory observation failed'}\n`);
    process.exitCode = 1;
  }
}
