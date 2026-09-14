import type { CardService } from '../cards/card-service.js';
import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import type { AgentName, CardNotification, CardTypeName, ToolResultPolicyTemplate } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import type { ManagedProcessScope, ProcessRunner } from '../runtime/process-runner.js';
import { getAnalystControlToolBinders } from './analyst-tool-registry.js';
import type { ToolContext } from './analyst-tool-types.js';
import { compileInvocationToolContract, type CompiledInvocationToolContract } from '../runtime/actors/context/context-blocks.js';
import { cardVersionToolBinders, type CardVersionProviderContext } from './card-version-provider.js';
import { cardInspectionToolBinders, type CardInspectionProviderContext } from './card-inspection-provider.js';
import { mcpToolBinders, type McpProviderContext } from './mcp-provider.js';
import { plannerControlToolBinders, type PlannerControlProviderContext } from './planner-control-provider.js';
import { cleanupProcessProvider, processToolBinders, type ProcessProviderContext } from './process-provider.js';
import { skillToolBinders, type SkillProviderContext } from './skill-provider.js';
import { webToolBinders, type WebProviderContext } from './web-tools.js';
import {
  analystPatchToolBinders,
  analystWorkspaceToolBinders,
  patchToolBinders,
  workspaceToolBinders,
  type WorkspaceProviderContext,
} from './workspace-provider.js';
import {
  type InvocationSurface,
  llmToolDefinition,
  type ToolBinder,
  type ToolDefinition,
  type ToolProvider,
  type ToolProviderCleanupReason,
} from './invocation.js';

type RuntimeToolScope = 'global' | 'card';

export interface CardToolBindingContext {
  readonly scope: 'card';
  readonly agentName: AgentName;
  readonly projectRoot: string;
  readonly store: CardService;
  readonly cardId: string;
  readonly sessionId: string;
  readonly parentControl: PlannerControlProviderContext['parentControl'];
  readonly childCreationTypes: ReadonlySet<CardTypeName>;
  readonly childActivationTypes: ReadonlySet<CardTypeName>;
  readonly cardTypeVocabulary: readonly CardTypeName[];
  readonly notifyCard: (cardId: string, notification: CardNotification) => NotifyCardResult;
  readonly submitNotification: import('../runtime/runtime-api.js').NotificationSubmissionPort;
  readonly processRunner: ProcessRunner;
  readonly processScope?: ManagedProcessScope;
  readonly processOwnerId?: string;
  readonly mcpToolInvocation: McpToolInvocationPort;
  readonly onRecordWritten?: (name: string) => void;
}

export interface GlobalToolBindingContext {
  readonly scope: 'global';
  readonly agentName: AgentName;
  readonly projectRoot: string;
  readonly store: CardService;
  readonly processRunner: ProcessRunner;
  readonly processScope: ManagedProcessScope;
  readonly processOwnerId: string;
  readonly mcpToolInvocation: McpToolInvocationPort;
  readonly analystToolContext: ToolContext;
  readonly cardTypeVocabulary: readonly CardTypeName[];
}

export type RuntimeToolBindingContext = CardToolBindingContext | GlobalToolBindingContext;

type RuntimeToolProviderGroup<Context> = Readonly<{
  key: string;
  providerName: string;
  scope: RuntimeToolScope;
  binders: readonly ToolBinder<Context, any>[];
  context(runtime: RuntimeToolBindingContext): Context;
  cleanup?(context: Context, reason: ToolProviderCleanupReason): Promise<void> | void;
}>;

type AnyProviderGroup = RuntimeToolProviderGroup<any>;
type CatalogEntry = Readonly<{ group: AnyProviderGroup; binder: ToolBinder<any, any> }>;

export type CompiledToolReference = Readonly<{
  scope: RuntimeToolScope;
  name: string;
  providerGroupId: string;
  description: string;
  resultPolicyTemplate: ToolResultPolicyTemplate;
}>;

const card = (runtime: RuntimeToolBindingContext): CardToolBindingContext => {
  if (runtime.scope !== 'card') throw new Error('Card tool group received global context.');
  return runtime;
};
const global = (runtime: RuntimeToolBindingContext): GlobalToolBindingContext => {
  if (runtime.scope !== 'global') throw new Error('Global tool group received card context.');
  return runtime;
};
const workspace = (runtime: CardToolBindingContext): WorkspaceProviderContext => ({ projectRoot: runtime.projectRoot, cardId: runtime.cardId, agentName: runtime.agentName, store: runtime.store, notifyCard: runtime.notifyCard, onRecordWritten: runtime.onRecordWritten });
const process = (runtime: RuntimeToolBindingContext): ProcessProviderContext => {
  if (!runtime.processScope || !runtime.processOwnerId) throw new Error(`Agent '${runtime.agentName}' process tools require a bound process scope.`);
  return { projectRoot: runtime.projectRoot, processRunner: runtime.processRunner, directScope: runtime.processScope, category: runtime.scope === 'global' ? 'operator_session' : 'runtime_card', ownerId: runtime.processOwnerId, ownerKind: runtime.scope === 'global' ? 'operator' : 'agent', ...(runtime.scope === 'card' ? { cardId: runtime.cardId } : {}) };
};
const web = (runtime: RuntimeToolBindingContext): WebProviderContext => ({ projectRoot: runtime.projectRoot, agentName: runtime.agentName, store: runtime.store, ...(runtime.scope === 'global' ? { analystToolContext: runtime.analystToolContext } : { cardId: runtime.cardId, notifyCard: runtime.notifyCard, onRecordWritten: runtime.onRecordWritten }) });

let defaultGroups: readonly AnyProviderGroup[] | null = null;
function runtimeToolGroups(): readonly AnyProviderGroup[] {
  if (defaultGroups) return defaultGroups;
  const source: AnyProviderGroup[] = [
  { key: 'global:analyst', providerName: 'analyst', scope: 'global', binders: getAnalystControlToolBinders(), context: (runtime) => global(runtime).analystToolContext },
  { key: 'card:planner-control', providerName: 'planner-control', scope: 'card', binders: plannerControlToolBinders, context: (runtime) => { const value = card(runtime); return { agentName: value.agentName, projectRoot: value.projectRoot, parentCardId: value.cardId, sessionId: value.sessionId, store: value.store, parentControl: value.parentControl, submitNotification: value.submitNotification, childCreationTypes: value.childCreationTypes, childActivationTypes: value.childActivationTypes, cardTypeVocabulary: value.cardTypeVocabulary }; } },
  ...(['global', 'card'] as const).flatMap((scope): AnyProviderGroup[] => [
    { key: `${scope}:card-inspection`, providerName: 'card-inspection', scope, binders: cardInspectionToolBinders, context: (runtime): CardInspectionProviderContext => ({ store: runtime.store, agentName: runtime.agentName, cardTypeVocabulary: runtime.cardTypeVocabulary, ...(runtime.scope === 'card' ? { cardId: runtime.cardId } : {}) }) },
    { key: `${scope}:card-version`, providerName: 'card-version', scope, binders: cardVersionToolBinders, context: (runtime): CardVersionProviderContext => ({ store: runtime.store }) },
    { key: `${scope}:workspace`, providerName: 'workspace', scope, binders: scope === 'global' ? analystWorkspaceToolBinders : workspaceToolBinders, context: (runtime) => scope === 'global' ? global(runtime).analystToolContext : workspace(card(runtime)) },
    { key: `${scope}:patch`, providerName: 'patch', scope, binders: scope === 'global' ? analystPatchToolBinders : patchToolBinders, context: (runtime) => scope === 'global' ? global(runtime).analystToolContext : workspace(card(runtime)) },
    { key: `${scope}:process`, providerName: 'process', scope, binders: processToolBinders, context: process, cleanup: cleanupProcessProvider },
    { key: `${scope}:web`, providerName: 'web', scope, binders: webToolBinders, context: web },
    { key: `${scope}:skill`, providerName: 'skill', scope, binders: skillToolBinders, context: (runtime): SkillProviderContext => ({ projectRoot: runtime.projectRoot, agentName: runtime.agentName }) },
    { key: `${scope}:mcp`, providerName: 'mcp', scope, binders: mcpToolBinders, context: (runtime): McpProviderContext => ({ mcpToolInvocation: runtime.mcpToolInvocation }) },
  ]),
  ];
  defaultGroups = Object.freeze(source.map((group) => Object.freeze(group)));
  return defaultGroups;
}

class ImmutableCatalogMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;
  constructor(entries: Iterable<readonly [K, V]>) { this.#values = new Map(entries); Object.freeze(this); }
  get size(){return this.#values.size;} get(key:K){return this.#values.get(key);} has(key:K){return this.#values.has(key);}
  entries(){return this.#values.entries();} keys(){return this.#values.keys();} values(){return this.#values.values();}
  forEach(callbackfn:(value:V,key:K,map:ReadonlyMap<K,V>)=>void,thisArg?:unknown){for(const [key,value] of this.#values)callbackfn.call(thisArg,value,key,this);}
  [Symbol.iterator](){return this.#values[Symbol.iterator]();} get [Symbol.toStringTag](){return 'ImmutableCatalogMap';}
}

export function buildRuntimeToolCatalog(sourceGroups: readonly AnyProviderGroup[] = runtimeToolGroups()): ReadonlyMap<string, CatalogEntry> {
  const catalog = new Map<string, CatalogEntry>();
  for (const group of sourceGroups) for (const binder of group.binders) {
    const key = `${group.scope}\u0000${binder.name}`;
    if (catalog.has(key)) throw new Error(`Duplicate runtime tool catalog entry '${group.scope}/${binder.name}'.`);
    catalog.set(key, Object.freeze({ group, binder }));
  }
  return new ImmutableCatalogMap(catalog);
}

let catalog: ReadonlyMap<string, CatalogEntry> | null = null;
const runtimeToolCatalog = (): ReadonlyMap<string, CatalogEntry> => catalog ??= buildRuntimeToolCatalog();

export function resolveRuntimeTool(scope: RuntimeToolScope, name: string): CompiledToolReference {
  const entry = runtimeToolCatalog().get(`${scope}\u0000${name}`);
  if (!entry) throw new Error(`unknown tool '${name}' for ${scope} session scope`);
  return Object.freeze({ scope, name, providerGroupId: entry.group.key, description: entry.binder.description, resultPolicyTemplate: entry.binder.resultPolicyTemplate });
}

export function effectiveCardNodeToolReferences(
  references: readonly CompiledToolReference[],
  childCreationTypes: ReadonlySet<CardTypeName>,
): readonly CompiledToolReference[] {
  return Object.freeze(childCreationTypes.size === 0
    ? references.filter((reference) => reference.name !== 'create_card')
    : [...references]);
}

export function surfaceToolContracts(surface: InvocationSurface): readonly CompiledInvocationToolContract[] {
  return Array.from(surface.tools.values(), (definition) => compileInvocationToolContract(llmToolDefinition(definition), definition.resultPolicyTemplate));
}

export class BoundAgentToolSet {
  readonly references: readonly CompiledToolReference[];
  readonly names: readonly string[];
  readonly requiresProcessScope: boolean;

  constructor(references: readonly CompiledToolReference[]) {
    this.references = Object.freeze([...references]);
    this.names = Object.freeze(references.map((reference) => reference.name));
    this.requiresProcessScope = references.some((reference) => reference.providerGroupId.endsWith(':process'));
    Object.freeze(this);
  }

  bind(runtime: RuntimeToolBindingContext): InvocationSurface {
    const selectedGroups = new Map<string, CatalogEntry[]>();
    for (const reference of this.references) {
      if (reference.scope !== runtime.scope) throw new Error(`Tool '${reference.name}' cannot bind to ${runtime.scope} scope.`);
      const entry = runtimeToolCatalog().get(`${reference.scope}\u0000${reference.name}`);
      if (!entry) throw new Error(`Compiled tool '${reference.scope}/${reference.name}' is absent from the runtime catalog.`);
      const selected = selectedGroups.get(reference.providerGroupId) ?? [];
      selected.push(entry);
      selectedGroups.set(reference.providerGroupId, selected);
    }
    const definitions = new Map<string, ToolDefinition>();
    const providers: ToolProvider[] = [];
    for (const group of runtimeToolGroups()) {
      const selected = selectedGroups.get(group.key);
      if (!selected) continue;
      const context = group.context(runtime);
      const tools = selected.map((entry) => entry.binder.bind(context));
      for (const definition of tools) definitions.set(definition.name, definition);
      providers.push({ providerName: group.providerName, tools: Object.freeze(tools), ...(group.cleanup ? { cleanup: (reason) => group.cleanup!(context, reason) } : {}) });
    }
    return { agentName: runtime.agentName, tools: new Map(this.names.map((name) => { const definition=definitions.get(name);if(!definition)throw new Error(`Bound tool '${name}' is missing its definition.`);return [name,definition] as const; })), providers: Object.freeze(providers) };
  }
}
