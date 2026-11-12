import type { CardService } from '../cards/store-api.js';
import type { DirectObjectAuthority } from './direct-object-authority.js';
import {
  capabilityResourceSchema,
  type CapabilityResource,
  type CapabilityScope,
} from '../schemas/index.js';
import { toolResourceMetadata, type ToolResourceMetadata } from './tool-resource-metadata.js';
import {
  nativeSourceToolBinders,
  type NativeSourceProviderContext,
} from './native-source-provider.js';
import type { QualityToolPort } from '../contracts/index.js';
import { qualityToolBinders, type QualityProviderContext } from './quality-provider.js';
import type { RetrievalPort } from '../contracts/index.js';
import { retrievalToolBinders, type RetrievalProviderContext } from './retrieval-provider.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import { MCP_OPERATIONS, type McpCaller } from '../mcp/manager-api.js';
import type {
  AgentName,
  CardNotification,
  CardTypeName,
  ToolResultPolicyTemplate,
} from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import type { ManagedProcessScope, ProcessRunner } from '../runtime/runtime-api.js';
import { getAnalystControlToolBinders } from './analyst-tool-registry.js';
import type { ToolContext } from './analyst-tool-types.js';
import {
  globalObservationToolBinders,
  type GlobalObservationToolContext,
} from './global-observation-tools.js';
import { compileInvocationToolContract } from '../runtime/runtime-api.js';
import { type CompiledInvocationToolContract } from '../contracts/index.js';
import {
  cardVersionToolBinders,
  type CardVersionProviderContext,
} from './card-version-provider.js';
import {
  cardInspectionToolBinders,
  type CardInspectionProviderContext,
} from './card-inspection-provider.js';
import { mcpToolBinders, type McpProviderContext } from './mcp-provider.js';
import {
  plannerControlToolBinders,
  type PlannerControlProviderContext,
} from './planner-control-provider.js';
import {
  cleanupProcessProvider,
  processToolBinders,
  type ProcessProviderContext,
} from './process-provider.js';
import { skillToolBinders, type SkillProviderContext } from './skill-provider.js';
import { webToolBinders, type WebProviderContext } from './web-tools.js';
import {
  analystPatchToolBinders,
  analystWorkspaceToolBinders,
  globalWorkspaceObservationToolBinders,
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
  readonly checkpointSource?: NativeSourceProviderContext['checkpointSource'];
  readonly quality?: QualityToolPort;
  readonly retrieval?: RetrievalPort;
  readonly outboundHttp?: import('../contracts/index.js').OutboundHttpEmitter;
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
  readonly processRunner: ProcessRunner;
  readonly processScope?: ManagedProcessScope;
  readonly processOwnerId?: string;
  readonly mcpToolInvocation: McpToolInvocationPort;
  readonly onRecordWritten?: (name: string) => void;
  readonly recordMutations: import('../application/record-mutation-service.js').CardAgentRecordMutationPort;
}

export interface GlobalToolBindingContext {
  readonly nativeGit?: boolean;
  readonly assertGlobalSourceWrite?: (absolutePath: string) => void;
  readonly quality?: QualityToolPort;
  readonly retrieval?: RetrievalPort;
  readonly outboundHttp?: import('../contracts/index.js').OutboundHttpEmitter;
  readonly scope: 'global';
  readonly agentName: AgentName;
  readonly projectRoot: string;
  readonly store: CardService;
  readonly processRunner: ProcessRunner;
  readonly processScope?: ManagedProcessScope;
  readonly processOwnerId?: string;
  readonly mcpToolInvocation: McpToolInvocationPort;
  readonly analystToolContext?: ToolContext;
  readonly observationToolContext?: Omit<GlobalObservationToolContext, 'authority'>;
  readonly cardTypeVocabulary: readonly CardTypeName[];
}

export type RuntimeToolBindingContext = CardToolBindingContext | GlobalToolBindingContext;
type AuthorizedRuntimeContext = RuntimeToolBindingContext & {
  readonly authority: DirectObjectAuthority;
};

type RuntimeToolProviderGroup<Context> = Readonly<{
  key: string;
  providerName: string;
  scope: RuntimeToolScope;
  binders: readonly ToolBinder<Context, any>[];
  context(runtime: AuthorizedRuntimeContext): Context;
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
  target: ToolResourceMetadata;
  resources: readonly CompiledCapabilityResource[];
}>;

type CompiledCapabilityResource =
  | Readonly<{ kind: 'card'; scopes: readonly CapabilityScope[] }>
  | Readonly<{ kind: 'workspace' }>
  | Readonly<{
      kind: 'record';
      scopes: readonly CapabilityScope[];
      patterns: readonly Readonly<{ source: string; matcher: RegExp }>[];
    }>;

/** Public/config projection of the actual compiled clauses, never a second policy. */
export function toolCapabilityResources(tool: CompiledToolReference): CapabilityResource[] {
  return tool.resources.map((resource) => {
    if (resource.kind === 'workspace') return { kind: 'workspace' };
    const scopes = [...resource.scopes];
    return resource.kind === 'card'
      ? { kind: 'card', scopes }
      : {
          kind: 'record',
          scopes,
          patterns: resource.patterns.map(({ source }) => source),
        };
  });
}

/** Framework eligibility on the caller's own record, not general target authorization. */
export function toolAllowsSelfRecord(tool: CompiledToolReference, name: string): boolean {
  return tool.resources.some(
    (resource) =>
      resource.kind === 'record' &&
      (resource.scopes.includes('self') || resource.scopes.includes('all')) &&
      resource.patterns.some(({ matcher }) => matcher.test(name)),
  );
}

function selectedGrantDescription(tool: CompiledToolReference): string {
  if (tool.target.target === 'none') return '';
  const clauses = tool.resources.map((clause) =>
    clause.kind === 'workspace'
      ? 'workspace'
      : clause.kind === 'card'
        ? `cards ${clause.scopes.join('|')}`
        : `records ${clause.scopes.join('|')} ${clause.patterns.map(({ source }) => source).join('|')}`,
  );
  return ` Direct objects: ${clauses.length ? clauses.join('; ') : 'no save destination'}.`;
}

const card = (runtime: RuntimeToolBindingContext): CardToolBindingContext => {
  if (runtime.scope !== 'card') throw new Error('Card tool group received global context.');
  return runtime;
};
const global = (runtime: RuntimeToolBindingContext): GlobalToolBindingContext => {
  if (runtime.scope !== 'global') throw new Error('Global tool group received card context.');
  return runtime;
};
const observation = (runtime: AuthorizedRuntimeContext): GlobalObservationToolContext => {
  const value = global(runtime);
  if (!value.observationToolContext)
    throw new Error(
      `Agent '${runtime.agentName}' requested a global observation tool without bound observation authority.`,
    );
  return { ...value.observationToolContext, authority: runtime.authority };
};
const workspace = (
  runtime: CardToolBindingContext & { authority: DirectObjectAuthority },
): WorkspaceProviderContext => ({
  authority: runtime.authority,
  recordMutations: runtime.recordMutations,
  projectRoot: runtime.projectRoot,
  cardId: runtime.cardId,
  agentName: runtime.agentName,
  store: runtime.store,
  notifyCard: runtime.notifyCard,
  onRecordWritten: runtime.onRecordWritten,
});
const process = (runtime: RuntimeToolBindingContext): ProcessProviderContext => {
  if (!runtime.processScope || !runtime.processOwnerId)
    throw new Error(`Agent '${runtime.agentName}' process tools require a bound process scope.`);
  return {
    projectRoot: runtime.projectRoot,
    processRunner: runtime.processRunner,
    directScope: runtime.processScope,
    category: runtime.scope === 'global' ? 'operator_session' : 'runtime_card',
    ownerId: runtime.processOwnerId,
    ownerKind: runtime.scope === 'global' ? 'operator' : 'agent',
    ...(runtime.scope === 'card' ? { cardId: runtime.cardId } : {}),
  };
};
const web = (runtime: AuthorizedRuntimeContext): WebProviderContext => ({
  authority: runtime.authority,
  outboundHttp: runtime.outboundHttp,
  projectRoot: runtime.projectRoot,
  agentName: runtime.agentName,
  store: runtime.store,
  ...(runtime.scope === 'global'
    ? {
        analystToolContext: global(runtime).analystToolContext,
        assertGlobalSourceWrite: global(runtime).assertGlobalSourceWrite,
      }
    : {
        cardId: runtime.cardId,
        recordMutations: runtime.recordMutations,
        notifyCard: runtime.notifyCard,
        onRecordWritten: runtime.onRecordWritten,
      }),
});

let defaultGroups: readonly AnyProviderGroup[] | null = null;
function runtimeToolGroups(): readonly AnyProviderGroup[] {
  if (defaultGroups) return defaultGroups;
  const source: AnyProviderGroup[] = [
    {
      key: 'card:native-source',
      providerName: 'native-source',
      scope: 'card',
      binders: nativeSourceToolBinders,
      context(runtime: AuthorizedRuntimeContext): NativeSourceProviderContext {
        const checkpointSource = card(runtime).checkpointSource;
        if (!checkpointSource)
          throw new Error('checkpoint_source requires the active native source owner.');
        return { checkpointSource, authority: runtime.authority };
      },
    },
    ...(['card', 'global'] as const).map((scope) => ({
      key: `${scope}:quality`,
      providerName: 'quality',
      scope,
      binders: qualityToolBinders,
      context(runtime: RuntimeToolBindingContext): QualityProviderContext {
        if (!runtime.quality)
          throw new Error('Selected quality tool requires bound runtime authority.');
        return {
          projectRoot: runtime.projectRoot,
          agentName: runtime.agentName,
          store: runtime.store,
          quality: runtime.quality,
          ...(runtime.scope === 'card' ? { cardId: runtime.cardId } : {}),
        };
      },
    })),
    {
      key: 'global:observation',
      providerName: 'observation',
      scope: 'global',
      binders: globalObservationToolBinders,
      context: observation,
    },
    {
      key: 'global:workspace-observation',
      providerName: 'workspace',
      scope: 'global',
      binders: globalWorkspaceObservationToolBinders,
      context: (runtime) => {
        const analyst = global(runtime).analystToolContext;
        return analyst ? { ...analyst, authority: runtime.authority } : observation(runtime);
      },
    },
    {
      key: 'global:analyst-workspace-mutation',
      providerName: 'workspace-mutation',
      scope: 'global',
      binders: analystWorkspaceToolBinders.filter(
        (binder) =>
          !globalWorkspaceObservationToolBinders.some((shared) => shared.name === binder.name),
      ),
      context: (runtime) => {
        const context = global(runtime).analystToolContext;
        if (!context)
          throw new Error(
            `Agent '${runtime.agentName}' requested an Analyst-only workspace mutation tool.`,
          );
        return { ...context, authority: runtime.authority };
      },
    },
    {
      key: 'global:analyst',
      providerName: 'analyst',
      scope: 'global',
      binders: getAnalystControlToolBinders(),
      context: (runtime) => {
        const context = global(runtime).analystToolContext;
        if (!context)
          throw new Error(`Agent '${runtime.agentName}' requested an Analyst-only tool.`);
        return context;
      },
    },
    {
      key: 'card:planner-control',
      providerName: 'planner-control',
      scope: 'card',
      binders: plannerControlToolBinders,
      context: (runtime) => {
        const value = card(runtime);
        return {
          authority: runtime.authority,
          agentName: value.agentName,
          projectRoot: value.projectRoot,
          parentCardId: value.cardId,
          sessionId: value.sessionId,
          store: value.store,
          parentControl: value.parentControl,
          childCreationTypes: value.childCreationTypes,
          childActivationTypes: value.childActivationTypes,
          cardTypeVocabulary: value.cardTypeVocabulary,
        };
      },
    },
    ...(['global', 'card'] as const).flatMap((scope): AnyProviderGroup[] => [
      {
        key: `${scope}:card-inspection`,
        providerName: 'card-inspection',
        scope,
        binders: cardInspectionToolBinders,
        context: (runtime): CardInspectionProviderContext => ({
          authority: runtime.authority,
          store: runtime.store,
          agentName: runtime.agentName,
          cardTypeVocabulary: runtime.cardTypeVocabulary,
          ...(runtime.scope === 'global'
            ? { currentProcessPosition: observation(runtime).currentProcessPosition }
            : { cardId: runtime.cardId }),
        }),
      },
      {
        key: `${scope}:card-version`,
        providerName: 'card-version',
        scope,
        binders: cardVersionToolBinders,
        context: (runtime): CardVersionProviderContext => ({
          store: runtime.store,
          authority: runtime.authority,
        }),
      },
      ...(scope === 'card'
        ? [
            {
              key: 'card:workspace',
              providerName: 'workspace',
              scope,
              binders: workspaceToolBinders,
              context: (runtime: AuthorizedRuntimeContext) =>
                workspace({ ...card(runtime), authority: runtime.authority }),
            },
          ]
        : []),
      {
        key: `${scope}:patch`,
        providerName: 'patch',
        scope,
        binders: scope === 'global' ? analystPatchToolBinders : patchToolBinders,
        context: (runtime) =>
          scope === 'global'
            ? { ...global(runtime).analystToolContext, authority: runtime.authority }
            : workspace({ ...card(runtime), authority: runtime.authority }),
      },
      {
        key: `${scope}:process`,
        providerName: 'process',
        scope,
        binders: processToolBinders,
        context: process,
        ...(scope === 'global' ? { cleanup: cleanupProcessProvider } : {}),
      },
      { key: `${scope}:web`, providerName: 'web', scope, binders: webToolBinders, context: web },
      {
        key: `${scope}:retrieval`,
        providerName: 'retrieval',
        scope,
        binders: retrievalToolBinders,
        context: (runtime): RetrievalProviderContext => {
          if (!runtime.retrieval) throw new Error('Observed source query owner not composed.');
          return {
            projectRoot: runtime.projectRoot,
            agentName: runtime.agentName,
            store: runtime.store,
            retrieval: runtime.retrieval,
            ...(runtime.scope === 'card' ? { cardId: runtime.cardId } : {}),
          };
        },
      },
      {
        key: `${scope}:skill`,
        providerName: 'skill',
        scope,
        binders: skillToolBinders,
        context: (runtime): SkillProviderContext => ({
          projectRoot: runtime.projectRoot,
          agentName: runtime.agentName,
        }),
      },
      {
        key: `${scope}:mcp`,
        providerName: 'mcp',
        scope,
        binders: mcpToolBinders,
        context: (runtime): McpProviderContext => ({
          projectRoot: runtime.projectRoot,
          mcpToolInvocation: runtime.mcpToolInvocation,
          mcpCaller: {
            principal:
              runtime.scope === 'card'
                ? { kind: 'card', cardId: runtime.cardId }
                : { kind: 'global' },
            operations: MCP_OPERATIONS.filter((name) =>
              runtime.authority.tools.some((tool) => tool.name === name),
            ),
          } satisfies McpCaller,
        }),
      },
    ]),
  ];
  defaultGroups = Object.freeze(source.map((group) => Object.freeze(group)));
  return defaultGroups;
}

class ImmutableCatalogMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;
  constructor(entries: Iterable<readonly [K, V]>) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }
  get size() {
    return this.#values.size;
  }
  get(key: K) {
    return this.#values.get(key);
  }
  has(key: K) {
    return this.#values.has(key);
  }
  entries() {
    return this.#values.entries();
  }
  keys() {
    return this.#values.keys();
  }
  values() {
    return this.#values.values();
  }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator]() {
    return this.#values[Symbol.iterator]();
  }
  get [Symbol.toStringTag]() {
    return 'ImmutableCatalogMap';
  }
}

export function buildRuntimeToolCatalog(
  sourceGroups: readonly AnyProviderGroup[] = runtimeToolGroups(),
): ReadonlyMap<string, CatalogEntry> {
  const catalog = new Map<string, CatalogEntry>();
  for (const group of sourceGroups)
    for (const binder of group.binders) {
      const key = `${group.scope}\u0000${binder.name}`;
      if (catalog.has(key))
        throw new Error(`Duplicate runtime tool catalog entry '${group.scope}/${binder.name}'.`);
      catalog.set(key, Object.freeze({ group, binder }));
    }
  return new ImmutableCatalogMap(catalog);
}

let catalog: ReadonlyMap<string, CatalogEntry> | null = null;
const runtimeToolCatalog = (): ReadonlyMap<string, CatalogEntry> =>
  (catalog ??= buildRuntimeToolCatalog());

export function resolveRuntimeTool(
  scope: RuntimeToolScope,
  name: string,
  resources?: readonly CapabilityResource[],
): CompiledToolReference {
  const entry = runtimeToolCatalog().get(`${scope}\u0000${name}`);
  if (!entry) throw new Error(`unknown tool '${name}' for ${scope} session scope`);
  const target = toolResourceMetadata(name);
  if (target.target === 'required' && !resources?.length)
    throw new Error(`Tool '${name}' requires resources.`);
  if (target.target === 'none' && resources !== undefined)
    throw new Error(`Tool '${name}' is targetless and must omit resources.`);
  if (resources?.length === 0) throw new Error(`Tool '${name}' resources must be nonempty.`);
  const clauses = (resources ?? []).map((input): CompiledCapabilityResource => {
    const resource = capabilityResourceSchema.parse(input);
    if (!target.kinds.includes(resource.kind))
      throw new Error(`Tool '${name}' does not support ${resource.kind} resources.`);
    if (resource.kind === 'workspace') return Object.freeze(resource);
    if (scope === 'global' && resource.scopes.some((value) => value !== 'all'))
      throw new Error(`Global tool '${name}' has no relative anchor; only all is permitted.`);
    const scopes = Object.freeze([...resource.scopes]);
    if (resource.kind === 'card') return Object.freeze({ kind: 'card', scopes });
    const patterns = resource.patterns.map((source) => {
      const escaped = source.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]*');
      const matcher = new RegExp(
        source === '*' ? '^[a-z][a-z0-9-]{0,63}\\.md$' : `^${escaped}$`,
        'u',
      );
      return Object.freeze({ source, matcher });
    });
    return Object.freeze({ kind: 'record', scopes, patterns: Object.freeze(patterns) });
  });
  return Object.freeze({
    scope,
    name,
    providerGroupId: entry.group.key,
    description: entry.binder.description,
    resultPolicyTemplate: entry.binder.resultPolicyTemplate,
    target,
    resources: Object.freeze(clauses),
  });
}

export function effectiveCardNodeToolReferences(
  references: readonly CompiledToolReference[],
  childCreationTypes: ReadonlySet<CardTypeName>,
): readonly CompiledToolReference[] {
  return Object.freeze(
    childCreationTypes.size === 0
      ? references.filter((reference) => reference.name !== 'create_card')
      : [...references],
  );
}

export function surfaceToolContracts(
  surface: InvocationSurface,
): readonly CompiledInvocationToolContract[] {
  return Array.from(surface.tools.values(), (definition) =>
    compileInvocationToolContract(llmToolDefinition(definition), definition.resultPolicyTemplate),
  );
}

export class BoundAgentToolSet {
  readonly references: readonly CompiledToolReference[];
  readonly names: readonly string[];
  readonly requiresProcessScope: boolean;

  constructor(references: readonly CompiledToolReference[]) {
    this.references = Object.freeze([...references]);
    this.names = Object.freeze(references.map((reference) => reference.name));
    this.requiresProcessScope = references.some((reference) =>
      reference.providerGroupId.endsWith(':process'),
    );
    Object.freeze(this);
  }

  bind(runtime: RuntimeToolBindingContext): InvocationSurface {
    const boundRuntime: AuthorizedRuntimeContext = {
      ...runtime,
      authority: Object.freeze({
        anchorCardId: runtime.scope === 'card' ? runtime.cardId : null,
        tools: this.references,
      }),
    };
    if (runtime.scope === 'global' && runtime.nativeGit) {
      this.assertNativeGitGlobalEligibility();
      if (
        !runtime.assertGlobalSourceWrite ||
        (runtime.analystToolContext && !runtime.analystToolContext.assertGlobalSourceWrite)
      )
        throw new Error('Native Git global binding requires final source-file admission.');
      if (runtime.quality)
        throw new Error('Native Git global binding refuses command-backed quality tools.');
    }
    const selectedGroups = new Map<string, CatalogEntry[]>();
    for (const reference of this.references) {
      if (reference.scope !== runtime.scope)
        throw new Error(`Tool '${reference.name}' cannot bind to ${runtime.scope} scope.`);
      const entry = runtimeToolCatalog().get(`${reference.scope}\u0000${reference.name}`);
      if (!entry)
        throw new Error(
          `Compiled tool '${reference.scope}/${reference.name}' is absent from the runtime catalog.`,
        );
      if (entry.group.key !== reference.providerGroupId)
        throw new Error(`Compiled tool '${reference.name}' has a mismatched provider binding.`);
      const selected = selectedGroups.get(reference.providerGroupId) ?? [];
      selected.push(entry);
      selectedGroups.set(reference.providerGroupId, selected);
    }
    const definitions = new Map<string, ToolDefinition>();
    const providers: ToolProvider[] = [];
    for (const group of runtimeToolGroups()) {
      const selected = selectedGroups.get(group.key);
      if (!selected) continue;
      const context = group.context(boundRuntime);
      const tools = selected.map((entry) => {
        const definition = entry.binder.bind(context);
        const reference = this.references.find(({ name }) => name === definition.name)!;
        return Object.freeze({
          ...definition,
          description: definition.description + selectedGrantDescription(reference),
        });
      });
      for (const definition of tools) definitions.set(definition.name, definition);
      providers.push({
        providerName: group.providerName,
        tools: Object.freeze(tools),
        ...(group.cleanup ? { cleanup: (reason) => group.cleanup!(context, reason) } : {}),
      });
    }
    return {
      agentName: runtime.agentName,
      tools: new Map(
        this.names.map((name) => {
          const definition = definitions.get(name);
          if (!definition) throw new Error(`Bound tool '${name}' is missing its definition.`);
          return [name, definition] as const;
        }),
      ),
      providers: Object.freeze(providers),
    };
  }

  assertNativeGitGlobalEligibility(): void {
    for (const reference of this.references) {
      const entry = runtimeToolCatalog().get(`global\u0000${reference.name}`);
      if (reference.scope !== 'global' || !entry || entry.group.key !== reference.providerGroupId)
        throw new Error('Native Git global tools require exact canonical provider bindings.');
      if (
        entry.group.key === 'global:quality' ||
        (entry.group.key === 'global:process' &&
          !['wait_process', 'kill_process'].includes(reference.name)) ||
        (entry.group.key === 'global:mcp' &&
          !['mcp_servers', 'mcp_tools'].includes(reference.name)) ||
        ![
          'global:observation',
          'global:workspace-observation',
          'global:analyst-workspace-mutation',
          'global:analyst',
          'global:card-inspection',
          'global:card-version',
          'global:patch',
          'global:web',
          'global:retrieval',
          'global:skill',
          'global:mcp',
          'global:process',
        ].includes(entry.group.key)
      )
        throw new Error(
          `Native Git global participant selects unsupported source writer '${reference.name}'.`,
        );
    }
  }
}
