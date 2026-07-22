import { readFileSync } from 'node:fs';
import * as YAML from 'yaml';

import { effectiveSaivageConfigSchema, saivageConfigSchema, type SaivageConfig } from '../agents/config-api.js';
import { interpolateValue, type EnvironmentSource } from './env-interpolation.js';
import { validateModelRoles } from './validate-model-roles.js';
import { replaceConfigYaml } from './config-file.js';
import type { AgentRole } from '../schemas/index.js';

export type ConfigSelectionSource =
  | { readonly kind: 'cli'; readonly argument: '--config' }
  | { readonly kind: 'environment'; readonly variable: 'SAIVAGE_CONFIG' }
  | { readonly kind: 'default' };

export type ConfigMutation =
  | { readonly kind: 'set_role_routing'; readonly role: AgentRole; readonly modelCandidate: string }
  | { readonly kind: 'set_failover_chain'; readonly forModel: string; readonly orderedFailoverModels: readonly string[] }
  | { readonly kind: 'set_runtime_setting'; readonly key: 'continuous_improvement'; readonly value: boolean }
  | { readonly kind: 'set_runtime_setting'; readonly key: 'process_timeouts'; readonly value: { readonly planner_ms: number; readonly executor_ms: number; readonly reviewer_ms: number } }
  | { readonly kind: 'set_server_setting'; readonly key: 'port'; readonly value: number }
  | { readonly kind: 'set_server_setting'; readonly key: 'host'; readonly value: string };

export type ConfigMutationResult =
  | { readonly success: true; readonly config: SaivageConfig; readonly warnings: readonly string[]; readonly requires_restart?: boolean }
  | { readonly success: false; readonly fieldPath: string; readonly message: string };

type ConfigDocument = YAML.Document.Parsed<YAML.ParsedNode, true>;
type RawConfig = Record<string, unknown>;

export interface ResolvedConfigAuthority {
  readonly path: string;
  readonly source: ConfigSelectionSource;
  readDocument(): ConfigDocument;
  validateDocument(document: ConfigDocument): { config: SaivageConfig; warnings: readonly string[] };
  loadEffective(): { config: SaivageConfig; warnings: readonly string[] };
  applyChange(mutation: ConfigMutation): ConfigMutationResult;
}

function isRecord(value: unknown): value is RawConfig {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function documentObject(document: ConfigDocument): RawConfig {
  const value = document.toJS() as unknown;
  if (!isRecord(value)) throw new Error('Configuration root must be a mapping.');
  return value;
}

function fieldPath(path: readonly PropertyKey[]): string {
  return path.map(String).join('/');
}

function roleValidationFailure(config: SaivageConfig): { fieldPath: string; message: string } | null {
  const roleCheck = validateModelRoles(config);
  if (roleCheck.ok) return null;
  const roles = roleCheck.missingRoles.join(', ');
  return {
    fieldPath: `models/${roleCheck.missingRoles[0]!}`,
    message: `missing model role(s): ${roles}. Set each role to a model name or a non-empty array, route it through models.routing['role'] and models.profiles['profile'], or set models.default in the selected configuration.`,
  };
}

class ResolvedConfigAuthorityImpl implements ResolvedConfigAuthority {
  readonly path: string;
  readonly source: ConfigSelectionSource;
  readonly #interpolationEnvironment: EnvironmentSource;

  constructor(path: string, source: ConfigSelectionSource, interpolationEnvironment: EnvironmentSource) {
    this.path = path;
    this.source = Object.freeze(source);
    this.#interpolationEnvironment = Object.freeze({ ...interpolationEnvironment });
    Object.freeze(this);
  }

  readDocument(): ConfigDocument {
    let source: string;
    try { source = readFileSync(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Configuration not found at ${this.path}`); throw error; }
    const document = YAML.parseDocument(source) as ConfigDocument;
    if (document.errors.length > 0) throw new Error(`Failed to parse configuration at ${this.path}: ${document.errors[0]!.message}`);
    documentObject(document);
    return document;
  }

  validateDocument(document: ConfigDocument): { config: SaivageConfig; warnings: readonly string[] } {
    const { value, warnings } = interpolateValue(documentObject(document), this.#interpolationEnvironment);
    const parsed = saivageConfigSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const path = fieldPath(issue.path);
      const error = new Error(`Configuration validation failed: ${path || '<root>'}: ${issue.message}`) as Error & { fieldPath?: string };
      error.fieldPath = path;
      throw error;
    }
    const roleFailure = roleValidationFailure(parsed.data);
    if (roleFailure) {
      const error = new Error(roleFailure.message) as Error & { fieldPath?: string };
      error.fieldPath = roleFailure.fieldPath;
      throw error;
    }
    return { config: effectiveSaivageConfigSchema.parse(parsed.data), warnings: Object.freeze([...warnings]) };
  }

  loadEffective(): { config: SaivageConfig; warnings: readonly string[] } {
    return this.validateDocument(this.readDocument());
  }

  applyChange(mutation: ConfigMutation): ConfigMutationResult {
    try {
      const document = this.readDocument();
      const precondition = this.applyMutation(document, mutation);
      if (precondition) return precondition;
      const effective = this.validateDocument(document);
      replaceConfigYaml(this.path, document);
      return {
        success: true as const,
        config: effective.config,
        warnings: effective.warnings,
        ...(mutation.kind === 'set_server_setting' ? { requires_restart: true } : {}),
      };
    } catch (error) {
      const failure = error as Error & { fieldPath?: string };
      return { success: false as const, fieldPath: failure.fieldPath ?? '/', message: failure.message };
    }
  }

  private applyMutation(document: ConfigDocument, mutation: ConfigMutation): ConfigMutationResult | void {
    switch (mutation.kind) {
      case 'set_role_routing':
        document.setIn(['models', 'routing', mutation.role], mutation.modelCandidate);
        return;
      case 'set_failover_chain':
        document.setIn(['models', 'failover', mutation.forModel], [...mutation.orderedFailoverModels]);
        return;
      case 'set_runtime_setting':
        document.setIn(['runtime', mutation.key], mutation.value);
        return;
      case 'set_server_setting':
        document.setIn(['server', mutation.key], mutation.value);
        return;
    }
  }
}

export function createResolvedConfigAuthority(input: {
  path: string;
  source: ConfigSelectionSource;
  interpolationEnvironment: EnvironmentSource;
}): ResolvedConfigAuthority {
  return new ResolvedConfigAuthorityImpl(input.path, input.source, input.interpolationEnvironment);
}
