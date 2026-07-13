import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import * as YAML from 'yaml';

import { saivageConfigSchema, type SaivageConfig } from '../agents/config-api.js';
import { cleanupDurableReplacementTemporaries, durablyReplaceFile } from '../persistence/durable-file-replacement.js';
import { interpolateValue, type EnvironmentSource } from './env-interpolation.js';
import { validateModelRoles } from './validate-model-roles.js';
import type { CompositionMutationAuthority, MutationAuthority } from '../application/mutation-authority.js';
import type { MutationLane } from '../application/mutation-lane.js';

export type ConfigSelectionSource =
  | { readonly kind: 'cli'; readonly argument: '--config' }
  | { readonly kind: 'environment'; readonly variable: 'SAIVAGE_CONFIG' }
  | { readonly kind: 'default' };

export type ConfigMutation =
  | { readonly kind: 'set_role_routing'; readonly role: string; readonly modelCandidate: string }
  | { readonly kind: 'set_failover_chain'; readonly forModel: string; readonly orderedFailoverModels: readonly string[] }
  | { readonly kind: 'mcp_add'; readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
  | { readonly kind: 'mcp_edit'; readonly name: string; readonly patch: { readonly command?: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> } }
  | { readonly kind: 'mcp_remove'; readonly name: string }
  | { readonly kind: 'set_runtime_setting'; readonly key: string; readonly value: unknown }
  | { readonly kind: 'set_server_setting'; readonly key: string; readonly value: unknown };

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
  restabilize(authority: CompositionMutationAuthority): void;
  initializeCanonicalDefaultIfMissing(authority: CompositionMutationAuthority): void;
  mutate(authority: MutationAuthority, mutation: ConfigMutation): ConfigMutationResult;
}

const RUNTIME_KEYS = new Set(['continuous_improvement', 'max_review_retries', 'process_timeouts']);
const SERVER_KEYS = new Set(['port', 'host']);
const CANONICAL_DEFAULT = 'models:\n  default:\n    - gpt-4.1\nproviders: {}\nserver:\n  host: 0.0.0.0\n  port: 8080\nruntime: {}\n';

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

  constructor(path: string, source: ConfigSelectionSource, interpolationEnvironment: EnvironmentSource, private readonly lane: MutationLane) {
    this.path = path;
    this.source = Object.freeze(source);
    this.#interpolationEnvironment = Object.freeze({ ...interpolationEnvironment });
    Object.freeze(this);
  }

  readDocument(): ConfigDocument {
    if (!existsSync(this.path)) throw new Error(`Configuration not found at ${this.path}`);
    const document = YAML.parseDocument(readFileSync(this.path, 'utf8')) as ConfigDocument;
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
    return { config: parsed.data, warnings: Object.freeze([...warnings]) };
  }

  loadEffective(): { config: SaivageConfig; warnings: readonly string[] } {
    return this.validateDocument(this.readDocument());
  }

  restabilize(authority: CompositionMutationAuthority): void {
    const result = this.lane.apply(authority, 'configuration restabilization', () => {
      const directory = dirname(this.path);
      if (existsSync(directory)) cleanupDurableReplacementTemporaries(directory, [basename(this.path)]);
    });
    if (!result.applied) throw new Error('Composition authority unexpectedly became stale.');
  }

  initializeCanonicalDefaultIfMissing(authority: CompositionMutationAuthority): void {
    const result = this.lane.apply(authority, 'configuration initialization', () => {
      if (existsSync(this.path)) return;
      mkdirSync(dirname(this.path), { recursive: true });
      durablyReplaceFile(this.path, Buffer.from(CANONICAL_DEFAULT));
    });
    if (!result.applied) throw new Error('Composition authority unexpectedly became stale.');
  }

  mutate(authority: MutationAuthority, mutation: ConfigMutation): ConfigMutationResult {
    const result = this.lane.apply(authority, 'configuration mutation', () => {
      try {
        const document = this.readDocument();
        const raw = documentObject(document);
        const precondition = this.applyMutation(document, raw, mutation);
        if (precondition) return precondition;
        const effective = this.validateDocument(document);
        durablyReplaceFile(this.path, Buffer.from(document.toString()));
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
    });
    if (!result.applied) throw new Error('Configuration mutation authority is stale.');
    return result.value;
  }

  private applyMutation(document: ConfigDocument, raw: RawConfig, mutation: ConfigMutation): ConfigMutationResult | void {
    switch (mutation.kind) {
      case 'set_role_routing':
        document.setIn(['models', 'routing', mutation.role], mutation.modelCandidate);
        return;
      case 'set_failover_chain':
        document.setIn(['models', 'failover', mutation.forModel], [...mutation.orderedFailoverModels]);
        return;
      case 'mcp_add': {
        const servers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
        if (servers[mutation.name]) return { success: false, fieldPath: `mcpServers/${mutation.name}`, message: `MCP server '${mutation.name}' already exists.` };
        document.setIn(['mcpServers', mutation.name], { command: mutation.command, args: [...(mutation.args ?? [])], env: { ...(mutation.env ?? {}) }, transport: 'stdio', disabled: false, autostart: true });
        return;
      }
      case 'mcp_edit': {
        const servers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
        const existing = servers[mutation.name];
        if (!isRecord(existing)) return { success: false, fieldPath: `mcpServers/${mutation.name}`, message: `MCP server '${mutation.name}' is not configured.` };
        const next = { ...existing };
        if (mutation.patch.command !== undefined) next.command = mutation.patch.command;
        if (mutation.patch.args !== undefined) next.args = [...mutation.patch.args];
        if (mutation.patch.env !== undefined) next.env = { ...mutation.patch.env };
        document.setIn(['mcpServers', mutation.name], next);
        return;
      }
      case 'mcp_remove': {
        const servers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
        if (!servers[mutation.name]) return { success: false, fieldPath: `mcpServers/${mutation.name}`, message: `MCP server '${mutation.name}' is not configured.` };
        document.deleteIn(['mcpServers', mutation.name]);
        return;
      }
      case 'set_runtime_setting':
        if (!RUNTIME_KEYS.has(mutation.key)) return { success: false, fieldPath: `runtime/${mutation.key}`, message: `Unknown runtime setting '${mutation.key}'.` };
        document.setIn(['runtime', mutation.key], mutation.value);
        return;
      case 'set_server_setting':
        if (!SERVER_KEYS.has(mutation.key)) return { success: false, fieldPath: `server/${mutation.key}`, message: `Unknown server setting '${mutation.key}'.` };
        document.setIn(['server', mutation.key], mutation.value);
        return;
    }
  }
}

export function createResolvedConfigAuthority(input: {
  path: string;
  source: ConfigSelectionSource;
  interpolationEnvironment: EnvironmentSource;
  lane: MutationLane;
}): ResolvedConfigAuthority {
  return new ResolvedConfigAuthorityImpl(input.path, input.source, input.interpolationEnvironment, input.lane);
}
