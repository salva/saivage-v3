import { readFileSync } from 'node:fs';
import * as YAML from 'yaml';

import { effectiveSaivageConfigSchema, saivageConfigSchema, type SaivageConfig } from '../schemas/saivage-config.js';
import { interpolateValue, type EnvironmentSource } from './env-interpolation.js';
import { replaceConfigYaml } from './config-file.js';
import { compileProjectWorkflows } from '../runtime/card-process/card-process-config.js';
import type { CompiledProjectWorkflows } from '../runtime/card-process/card-process-config.js';
import type { WorkflowCompileOptions } from '../runtime/card-process/card-process-config.js';

export type ConfigSelectionSource =
  | { readonly kind: 'cli'; readonly argument: '--config' }
  | { readonly kind: 'environment'; readonly variable: 'SAIVAGE_CONFIG' }
  | { readonly kind: 'default' };

export type ConfigMutation =
  | { readonly kind: 'set_agent_model_route'; readonly agent: string; readonly modelRoute: string }
  | { readonly kind: 'set_model_failover'; readonly forModel: string; readonly orderedFailoverModels: readonly string[] }
  | { readonly kind: 'set_server_setting'; readonly key: 'port'; readonly value: number }
  | { readonly kind: 'set_server_setting'; readonly key: 'host'; readonly value: string };

export type ConfigMutationResult =
  | { readonly success: true; readonly config: SaivageConfig; readonly warnings: readonly string[]; readonly requires_restart: true }
  | { readonly success: false; readonly fieldPath: string; readonly message: string };

type ConfigDocument = YAML.Document.Parsed<YAML.ParsedNode, true>;
type RawConfig = Record<string, unknown>;

export interface ResolvedConfigAuthority {
  readonly path: string;
  readonly source: ConfigSelectionSource;
  readDocument(): ConfigDocument;
  validateDocument(document: ConfigDocument): { config: SaivageConfig; workflows:CompiledProjectWorkflows;warnings: readonly string[] };
  loadEffective(): { config: SaivageConfig;workflows:CompiledProjectWorkflows; warnings: readonly string[] };
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

class ResolvedConfigAuthorityImpl implements ResolvedConfigAuthority {
  readonly path: string;
  readonly source: ConfigSelectionSource;
  readonly #interpolationEnvironment: EnvironmentSource;
  readonly #compileOptions: WorkflowCompileOptions;

  constructor(path: string, source: ConfigSelectionSource, interpolationEnvironment: EnvironmentSource, compileOptions:WorkflowCompileOptions) {
    this.path = path;
    this.source = Object.freeze(source);
    this.#interpolationEnvironment = Object.freeze({ ...interpolationEnvironment });
    this.#compileOptions=Object.freeze({...compileOptions});
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

  validateDocument(document: ConfigDocument): { config: SaivageConfig;workflows:CompiledProjectWorkflows; warnings: readonly string[] } {
    const { value, warnings } = interpolateValue(documentObject(document), this.#interpolationEnvironment);
    const parsed = saivageConfigSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const path = fieldPath(issue.path);
      const error = new Error(`Configuration validation failed: ${path || '<root>'}: ${issue.message}`) as Error & { fieldPath?: string };
      error.fieldPath = path;
      throw error;
    }
    const config = effectiveSaivageConfigSchema.parse(parsed.data);
    return { config,workflows:compileProjectWorkflows(config,this.#compileOptions), warnings: Object.freeze([...warnings]) };
  }

  loadEffective(): { config: SaivageConfig;workflows:CompiledProjectWorkflows; warnings: readonly string[] } {
    return this.validateDocument(this.readDocument());
  }

  applyChange(mutation: ConfigMutation): ConfigMutationResult {
    try {
      const document = this.readDocument();
      const current=this.validateDocument(document).config;
      const precondition = this.applyMutation(document, mutation,current);
      if (precondition) return precondition;
      const effective = this.validateDocument(document);
      replaceConfigYaml(this.path, document);
      return {
        success: true as const,
        config: effective.config,
        warnings: effective.warnings,
        requires_restart: true,
      };
    } catch (error) {
      const failure = error as Error & { fieldPath?: string };
      return { success: false as const, fieldPath: failure.fieldPath ?? '/', message: failure.message };
    }
  }

  private applyMutation(document: ConfigDocument, mutation: ConfigMutation,current:SaivageConfig): ConfigMutationResult | void {
    switch (mutation.kind) {
      case 'set_agent_model_route':
        if (!document.getIn(['agents', mutation.agent])) return { success: false, fieldPath: `agents/${mutation.agent}`, message: `Unknown agent '${mutation.agent}'.` };
        if (!document.getIn(['models', 'routes', mutation.modelRoute])) return { success: false, fieldPath: `models/routes/${mutation.modelRoute}`, message: `Unknown model route '${mutation.modelRoute}'.` };
        document.setIn(['agents', mutation.agent, 'model_route'], mutation.modelRoute);
        return;
      case 'set_model_failover':
        {const models=new Set<string>();for(const route of Object.values(current.models.routes)){for(const model of route.candidates??[] )models.add(model);if(route.profile)for(const model of [...current.models.profiles[route.profile]!.preferred,...current.models.profiles[route.profile]!.allowed])models.add(model);}for(const group of current.models.equivalents)for(const model of group)models.add(model);if(!models.has(mutation.forModel))return {success:false,fieldPath:`models/failover/${mutation.forModel}`,message:`Unknown model '${mutation.forModel}'.`};for(const model of mutation.orderedFailoverModels)if(!models.has(model))return {success:false,fieldPath:`models/failover/${mutation.forModel}`,message:`Unknown failover model '${model}'.`};}
        document.setIn(['models', 'failover', mutation.forModel], [...mutation.orderedFailoverModels]);
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
  projectRoot?:string;
}): ResolvedConfigAuthority {
  return new ResolvedConfigAuthorityImpl(input.path, input.source, input.interpolationEnvironment,input.projectRoot?{projectRoot:input.projectRoot}:{});
}
