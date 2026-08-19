import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentName } from '../../schemas/agent-name.js';
import { parseRecordName, type RecordName } from '../../schemas/record-name.js';
import type { CardTypeSource, SaivageConfig } from '../../schemas/saivage-config.js';
import { parseCardTypeName, type CardStatus, type CardTypeName } from '../../schemas/index.js';
import { validateCompiledActorTable } from '../micro-actor/index.js';
import { compilePromptTemplate, renderCompiledPrompt, type AgentPromptHost, type CompiledPromptTemplate, type ProcessPromptHost, type PromptHost } from '../../utils/prompt-api.js';
import type { Candidate } from '../../contracts/provider-candidate.js';
import type { ModelRouter } from '../../agents/model-router.js';
import { capabilityRequestForTools, type CapabilityRequest } from '../../agents/provider-capabilities.js';
import { BoundAgentToolSet, effectiveCardNodeToolReferences, resolveRuntimeTool, type CompiledToolReference } from '../../tools/runtime-tool-catalog.js';
import { z } from 'zod';
import { TERMINAL_RESULT_TOOL_NAME } from '../../contracts/result-envelope.js';
import { zodToJsonSchemaMini } from '../../agents/zod-to-jsonschema-mini.js';
import type { ToolDefinition as LlmToolDefinition } from '../../agents/llm-contracts.js';

export type CardProcessEntry = 'BACKLOG' | 'CHANGED' | 'BLOCKED' | 'STOPPED';
export type CardProcessTerminal = 'DONE' | 'BLOCKED' | 'FAILED';
export type ProcessPromptId = string & { readonly __processPromptId: unique symbol };
export type RecordRequirementMode = 'clean' | 'continue';
export type RecordRequirementGate = 'exists' | 'updated';
export type PromptArtifactSource = 'override-card'|'override-shared'|'bundled-card'|'bundled-shared';
export type PromptArtifactObservation = Readonly<{ source: PromptArtifactSource; path: string }>;
export type CompiledAgentPrompt = Readonly<{ source:PromptArtifactSource; reference:string; path:string; compiled:CompiledPromptTemplate }>;
export type CompiledProcessPrompt = Readonly<{ reference:ProcessPromptId; source:PromptArtifactSource; path:string; text:string }>;
export interface WorkflowCompileOptions { readonly projectRoot?:string; readonly defaultPromptRoot?:string; readonly artifactObserver?:(artifact:PromptArtifactObservation)=>void }
type PromptRoots = Readonly<{ defaultRoot:string; overrideRoot:string|undefined; artifactObserver:((artifact:PromptArtifactObservation)=>void)|undefined; agentCache:Map<string,CompiledAgentPrompt> }>;

export type CompiledRecordDefinition = Readonly<{ name: RecordName; format: 'markdown'; schema: string; bootstrap: boolean; declared: boolean }>;
export type CompiledRecordWritePattern = Readonly<{ source: string; matcher: RegExp }>;
export type CompiledAgentContract = Readonly<{ name: AgentName; prompt: string; tools: readonly CompiledToolReference[]; recordWrites: readonly CompiledRecordWritePattern[]; modelRoute: string; model: Readonly<{ orderedModelIds: readonly string[]; temperature: number; maxTokens: number }>; skills: boolean; session: 'global' | 'card'; canCreateChildren: boolean }>;
export type CompiledRecordRequirement = Readonly<{ definition: CompiledRecordDefinition; mode: RecordRequirementMode; gate: RecordRequirementGate }>;
export type CompiledDescendantContext = Readonly<{ records: readonly CompiledRecordDefinition[]; requireUnchangedUntilAccept: boolean }>;
export type CompiledTerminalBehavior = Readonly<{ promotion: Readonly<{ kind: 'current' } | { kind: 'latest-node'; nodeId: string }>; exportRecords: readonly CompiledRecordDefinition[] }>;
export type ProcessTransitionSemantic =
  | Readonly<{ kind: 'activation' }>
  | Readonly<{ kind: 'entry-route'; promptId: ProcessPromptId | null }>
  | Readonly<{ kind: 'configured-outcome'; outcome: string; promptId: ProcessPromptId | null; terminalBehavior: CompiledTerminalBehavior | null }>
  | Readonly<{ kind: 'runtime-terminal'; cause: 'failed' | 'blocked' }>;
export type CompiledProcessTransition = Readonly<{ targetStateId: string; reenter: boolean; semantic: ProcessTransitionSemantic }>;
type ProcessStateBase = Readonly<{ on: ReadonlyMap<string, CompiledProcessTransition>; isTerminal: boolean; isParked: boolean }>;
export type CompiledNodeContract = ProcessStateBase & Readonly<{ kind: 'node'; nodeId: string; agent: CompiledAgentContract; selectedAgentPrompt:CompiledAgentPrompt; promptId: ProcessPromptId; correctionPromptId: ProcessPromptId; requirements: readonly CompiledRecordRequirement[]; descendantContext: CompiledDescendantContext | null; childCreationTypes: ReadonlySet<CardTypeName>; childActivationTypes: ReadonlySet<CardTypeName>; readableRecords: ReadonlyMap<RecordName, CompiledRecordDefinition> }>;
export type CompiledProcessState =
  | (ProcessStateBase & Readonly<{ kind: 'ready' }>)
  | (ProcessStateBase & Readonly<{ kind: 'entry'; entry: CardProcessEntry }>)
  | CompiledNodeContract
  | (ProcessStateBase & Readonly<{ kind: 'terminal'; terminal: CardProcessTerminal }>);
export type ProcessPosition = Readonly<{ cardType: CardTypeName; stateId: string; kind: 'ready' }> | Readonly<{ cardType: CardTypeName; stateId: string; kind: 'entry'; entry: CardProcessEntry }> | Readonly<{ cardType: CardTypeName; stateId: string; kind: 'node'; nodeId: string; executionOrdinal: number }> | Readonly<{ cardType: CardTypeName; stateId: string; kind: 'terminal'; terminal: CardProcessTerminal }>;
export interface CompiledCardTypeWorkflow { readonly cardType: CardTypeName; readonly permittedChildTypes: ReadonlySet<CardTypeName>; readonly records: ReadonlyMap<RecordName, CompiledRecordDefinition>; readonly bootstrapRecord: CompiledRecordDefinition; readonly initialStateId: 'lifecycle:ready'; readonly states: ReadonlyMap<string, CompiledProcessState>; readonly processPrompts:ReadonlyMap<ProcessPromptId,CompiledProcessPrompt> }
export interface CompiledProjectWorkflows { readonly analyst: CompiledAgentContract; readonly analystPrompt:CompiledAgentPrompt; readonly agents: ReadonlyMap<AgentName, CompiledAgentContract>; readonly cardTypes: ReadonlyMap<CardTypeName, CompiledCardTypeWorkflow>; readonly cardTypeVocabulary: readonly CardTypeName[] }
export type BoundAgentContract = Readonly<{ contract: CompiledAgentContract; candidateChain: readonly Candidate[]; toolSet: BoundAgentToolSet; capabilityRequest: CapabilityRequest }>;
export interface CompiledRuntimeWorkflows extends CompiledProjectWorkflows { readonly runtimeBound: true;readonly agentBindings:ReadonlyMap<AgentName,BoundAgentContract> }

const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u;
const OUTCOME_IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/u;
const ENTRY_PORTS = ['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'] as const;
const TERMINAL_PORTS = ['DONE', 'BLOCKED', 'FAILED'] as const;
export const GENERIC_RECORD_SCHEMA = 'authored-record.v1';

class ImmutableMap<K, V> implements ReadonlyMap<K, V> { readonly #values: Map<K,V>; constructor(entries: Iterable<readonly [K,V]>) { this.#values = new Map(entries); Object.freeze(this); } get size(){return this.#values.size;} get(key:K){return this.#values.get(key);} has(key:K){return this.#values.has(key);} entries(){return this.#values.entries();} keys(){return this.#values.keys();} values(){return this.#values.values();} forEach(callbackfn:(value:V,key:K,map:ReadonlyMap<K,V>)=>void,thisArg?:unknown){for(const [k,v] of this.#values) callbackfn.call(thisArg,v,k,this);} [Symbol.iterator](){return this.#values[Symbol.iterator]();} get [Symbol.toStringTag](){return 'ImmutableMap';} }
class ImmutableSet<T> implements ReadonlySet<T> { readonly #values:Set<T>; constructor(values:Iterable<T>){this.#values=new Set(values);Object.freeze(this);} get size(){return this.#values.size;} has(value:T){return this.#values.has(value);} entries(){return this.#values.entries();} keys(){return this.#values.keys();} values(){return this.#values.values();} forEach(callbackfn:(value:T,value2:T,set:ReadonlySet<T>)=>void,thisArg?:unknown){for(const value of this.#values)callbackfn.call(thisArg,value,value,this);} [Symbol.iterator](){return this.#values[Symbol.iterator]();} get [Symbol.toStringTag](){return 'ImmutableSet';} }
const immutableMap=<K,V>(entries:Iterable<readonly [K,V]>):ReadonlyMap<K,V>=>new ImmutableMap(entries);
const immutableSet=<T>(values:Iterable<T>):ReadonlySet<T>=>new ImmutableSet(values);
function bundledPromptRoot():string{const moduleDir=dirname(fileURLToPath(import.meta.url));const source=join(moduleDir,'..','..','prompts');return existsSync(source)?source:join(moduleDir,'..','..','..','prompts');}
function promptRoots(options:WorkflowCompileOptions):PromptRoots{return{defaultRoot:options.defaultPromptRoot??bundledPromptRoot(),overrideRoot:options.projectRoot?join(options.projectRoot,'.saivage','config','prompts'):undefined,artifactObserver:options.artifactObserver,agentCache:new Map()};}
function readUtf8(path:string):string{const text=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path));if(text.trim().length===0)throw new Error(`Prompt artifact '${path}' must contain non-whitespace UTF-8 text.`);return text;}
function readOptional(path:string):string|null{try{return readUtf8(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
type PromptPurpose='agents'|'process'|'fragments';
type SelectedPrompt=Readonly<{source:PromptArtifactSource;path:string;text:string}>;
function selectPrompt(purpose:PromptPurpose,host:PromptHost,reference:string,roots:PromptRoots):SelectedPrompt{
  const candidates:Array<readonly[PromptArtifactSource,string]>=[];
  if(roots.overrideRoot){if(host.kind!=='global-agent')candidates.push(['override-card',join(roots.overrideRoot,purpose,host.cardType,`${reference}.md`)]);candidates.push(['override-shared',join(roots.overrideRoot,purpose,'_shared',`${reference}.md`)]);}
  if(host.kind!=='global-agent')candidates.push(['bundled-card',join(roots.defaultRoot,purpose,host.cardType,`${reference}.md`)]);
  candidates.push(['bundled-shared',join(roots.defaultRoot,purpose,'_shared',`${reference}.md`)]);
  for(const[source,path]of candidates){const text=readOptional(path);if(text!==null){roots.artifactObserver?.(Object.freeze({source,path:resolve(path)}));return Object.freeze({source,path,text});}}
  const [source,path]=candidates[candidates.length-1]!;
  const text=readUtf8(path);roots.artifactObserver?.(Object.freeze({source,path:resolve(path)}));return Object.freeze({source,path,text});
}
function compileSelected(host:AgentPromptHost,name:AgentName,reference:string,roots:PromptRoots):CompiledAgentPrompt{
  const cacheKey=host.kind==='global-agent'?`${host.kind}/${reference}`:`${host.kind}/${host.cardType}/${reference}`;
  const cached=roots.agentCache.get(cacheKey);if(cached)return cached;
  const selected=selectPrompt('agents',host,reference,roots);
  const compiled=compilePromptTemplate({host,name,path:selected.path,text:selected.text,resolveFragment:(id)=>{const fragment=selectPrompt('fragments',host,id,roots);return{path:fragment.path,text:fragment.text};}});
  const artifact=Object.freeze({source:selected.source,reference,path:selected.path,compiled});roots.agentCache.set(cacheKey,artifact);return artifact;
}
function selectAgentPrompt(
  host: AgentPromptHost,
  agent: CompiledAgentContract,
  roots: PromptRoots,
): CompiledAgentPrompt {
  return compileSelected(host,agent.name,agent.prompt,roots);
}
function selectProcessPrompt(
  cardType: CardTypeName,
  id: ProcessPromptId,
  roots: PromptRoots,
): CompiledProcessPrompt {
  const host:ProcessPromptHost={kind:'process',cardType};
  const selected=selectPrompt('process',host,id,roots);
  const compiled=compilePromptTemplate({host,name:id,path:selected.path,text:selected.text,resolveFragment:(fragmentId)=>{const fragment=selectPrompt('fragments',host,fragmentId,roots);return{path:fragment.path,text:fragment.text};}});
  return Object.freeze({reference:id,source:selected.source,path:selected.path,text:renderCompiledPrompt(host,id,compiled,{cardType})});
}
function identifier(value:string,location:string):string { if(!IDENTIFIER.test(value))throw new Error(`${location} must be a lowercase identifier of at most 64 characters.`);return value; }
function promptId(value:string,location:string):ProcessPromptId{return identifier(value,location) as ProcessPromptId;}
function outcomeIdentifier(value:string,location:string):string{if(!OUTCOME_IDENTIFIER.test(value))throw new Error(`${location} must be a lowercase outcome identifier of at most 64 characters.`);return value;}
const nodeState=(id:string)=>`node:${id}`; const entryState=(entry:CardProcessEntry)=>`entry:${entry}`; const terminalState=(terminal:CardProcessTerminal)=>`terminal:${terminal}`;
export function cardProcessEntryForStatus(status:CardStatus):CardProcessEntry|null{if(status==='backlog')return'BACKLOG';if(status==='changed')return'CHANGED';if(status==='blocked')return'BLOCKED';if(status==='stopped')return'STOPPED';return null;}

function resolveRoute(config:SaivageConfig,name:string):readonly string[]{const route=config.models.routes[name];if(!route)throw new Error(`models.routes.${name} is missing.`);if(route.candidates){if(new Set(route.candidates).size!==route.candidates.length)throw new Error(`models.routes.${name}.candidates contains a duplicate.`);return Object.freeze([...route.candidates]);}const profile=config.models.profiles[route.profile!];if(!profile)throw new Error(`models.routes.${name}.profile references missing profile '${route.profile}'.`);const candidates=[...profile.preferred,...profile.allowed];if(candidates.length===0)throw new Error(`models.routes.${name}.profile resolves to no candidates.`);if(new Set(candidates).size!==candidates.length)throw new Error(`models.profiles.${route.profile} contains a duplicate candidate.`);return Object.freeze(candidates);}
function expandModelOrder(config: SaivageConfig, routeName: string): readonly string[] {
  const emitted = new Set<string>();
  const ordered: string[] = [];
  const append = (model: string) => { if (!emitted.has(model)) { emitted.add(model); ordered.push(model); } };
  for (const model of resolveRoute(config, routeName)) {
    append(model);
    const group = config.models.equivalents.find((candidate) => candidate.includes(model));
    if (group) for (const equivalent of group) if (equivalent !== model) append(equivalent);
    const failover = config.models.failover[model];
    if (failover) for (const candidate of failover) append(candidate);
  }
  return Object.freeze(ordered);
}
function compileRecordWritePattern(source:string):CompiledRecordWritePattern { const escaped=source.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'[a-z0-9-]*');return Object.freeze({source,matcher:new RegExp(`^${escaped}$`,'u')}); }
export function agentCanWriteRecord(agent:CompiledAgentContract,name:RecordName):boolean{return agent.recordWrites.some(({matcher})=>matcher.test(name));}
export function genericRecordDefinition(name:RecordName):CompiledRecordDefinition{return Object.freeze({name,format:'markdown',schema:GENERIC_RECORD_SCHEMA,bootstrap:false,declared:false});}
function compileAgents(config:SaivageConfig):ReadonlyMap<AgentName,CompiledAgentContract>{const result:Array<readonly[AgentName,CompiledAgentContract]>=[];for(const[rawName,source]of Object.entries(config.agents)){const name=rawName as AgentName;const duplicate=new Set<string>();const tools:CompiledToolReference[]=[];for(const tool of source.tools){if(duplicate.has(tool))throw new Error(`agents.${name}.tools contains duplicate '${tool}'.`);duplicate.add(tool);try{tools.push(resolveRuntimeTool(source.session,tool));}catch{throw new Error(`agents.${name}.tools contains unknown tool '${tool}' for ${source.session} session scope.`);}}const patternNames=new Set<string>();const recordWrites=source.record_writes.map((pattern)=>{if(patternNames.has(pattern))throw new Error(`agents.${name}.record_writes contains duplicate '${pattern}'.`);patternNames.add(pattern);return compileRecordWritePattern(pattern);});if(source.skills!==tools.some((tool)=>tool.name==='skill'))throw new Error(`agents.${name}.skills must agree with the skill tool.`);if(tools.some((tool)=>tool.name==='create_card')&&!source.can_create_children)throw new Error(`agents.${name} cannot list create_card when can_create_children is false.`);const route=config.models.routes[source.model_route];if(!route)throw new Error(`agents.${name}.model_route references missing route '${source.model_route}'.`);result.push([name,Object.freeze({name,prompt:source.prompt,tools:Object.freeze(tools),recordWrites:Object.freeze(recordWrites),modelRoute:source.model_route,model:Object.freeze({orderedModelIds:expandModelOrder(config,source.model_route),temperature:route.temperature,maxTokens:route.max_tokens}),skills:source.skills,session:source.session,canCreateChildren:source.can_create_children})]);}return immutableMap(result);}

type ProcessEdgeDraft = Readonly<{ outcome:string; targetStateId:string; targetNodeId:string|null; promptId:ProcessPromptId|null; terminalBehavior:CompiledTerminalBehavior|null }>;
type ProcessNodeDraft = Readonly<{
  nodeId: string;
  agent: CompiledAgentContract;
  selectedAgentPrompt: CompiledAgentPrompt;
  promptId: ProcessPromptId;
  correctionPromptId: ProcessPromptId;
  requirements: readonly CompiledRecordRequirement[];
  descendantContext: CompiledDescendantContext | null;
  edges: ReadonlyMap<string, ProcessEdgeDraft>;
  childCreationTypes: ReadonlySet<CardTypeName>;
  childActivationTypes: ReadonlySet<CardTypeName>;
}>;
type CardTypeCompileDraft = Readonly<{
  cardType: CardTypeName;
  location: string;
  permittedChildTypes: ReadonlySet<CardTypeName>;
  records: ReadonlyMap<RecordName, CompiledRecordDefinition>;
  bootstrapRecord: CompiledRecordDefinition;
  nodes: ReadonlyMap<string, ProcessNodeDraft>;
  entries: ReadonlyMap<
    CardProcessEntry,
    Readonly<{ targetNodeId: string; promptId: ProcessPromptId | null }>
  >;
}>;

function compileCardTypeInputs(
  cardType: CardTypeName,
  source: CardTypeSource,
  agents: ReadonlyMap<AgentName, CompiledAgentContract>,
  roots: PromptRoots,
  configuredCardTypes: ReadonlySet<CardTypeName>,
): CardTypeCompileDraft {
  const location = `card_types.${cardType}`;
  const children = new Set<CardTypeName>();
  for (const child of source.permitted_child_types) {
    if (child === 'project')
      throw new Error(`${location}.permitted_child_types cannot contain project.`);
    if (children.has(child))
      throw new Error(`${location}.permitted_child_types contains duplicate '${child}'.`);
    if (!configuredCardTypes.has(child))
      throw new Error(`${location}.permitted_child_types references missing card type '${child}'.`);
    children.add(child);
  }
  const permittedChildTypes = immutableSet(children);
  const recordEntries: Array<readonly [RecordName, CompiledRecordDefinition]> = [];
  let bootstrapRecord: CompiledRecordDefinition | null = null;
  for (const [rawName, value] of Object.entries(source.records)) {
    const name = parseRecordName(rawName);
    const definition = Object.freeze({
      name,
      format: value.format,
      schema: value.schema,
      bootstrap: value.bootstrap,
      declared: true,
    });
    recordEntries.push([name, definition]);
    if (value.bootstrap) {
      if (bootstrapRecord)
        throw new Error(`${location}.records must contain exactly one bootstrap record.`);
      bootstrapRecord = definition;
    }
  }
  if (!bootstrapRecord)
    throw new Error(`${location}.records must contain exactly one bootstrap record.`);
  const records = immutableMap(recordEntries);
  const nodes = new Map<string, ProcessNodeDraft>();
  for (const [rawNodeId, node] of Object.entries(source.workflow.nodes)) {
    const nodeId = identifier(rawNodeId, `${location}.workflow.nodes key`);
    const agent = agents.get(node.agent);
    if (!agent)
      throw new Error(
        `${location}.workflow.nodes.${nodeId}.agent references missing agent '${node.agent}'.`,
      );
    if (agent.session !== 'card')
      throw new Error(`${location}.workflow.nodes.${nodeId}.agent must use card session scope.`);
    const requirements: Array<CompiledRecordRequirement> = [];
    for (const [rawRecord, requirement] of Object.entries(node.records)) {
      const name = parseRecordName(rawRecord);
      const definition = records.get(name) ?? genericRecordDefinition(name);
      if (!agentCanWriteRecord(agent,name)) throw new Error(`${location}.workflow.nodes.${nodeId}.records.${name} requires matching agent record_writes authority.`);
      const requiresWrite=requirement.mode==='clean'||requirement.gate==='updated';
      if(requiresWrite&&!agent.tools.some((tool)=>tool.name==='write'))throw new Error(`${location}.workflow.nodes.${nodeId}.records.${name} (${requirement.mode} + ${requirement.gate}) requires the write tool.`);
      requirements.push(Object.freeze({ definition, mode:requirement.mode, gate:requirement.gate }));
    }
    const edges = new Map<string, ProcessEdgeDraft>();
    for (const [rawOutcome, edge] of Object.entries(node.edges)) {
      const outcome = outcomeIdentifier(
        rawOutcome,
        `${location}.workflow.nodes.${nodeId}.edges key`,
      );
      if ('node' in edge.target) {
        edges.set(
          outcome,
          Object.freeze({
            outcome,
            targetStateId: nodeState(edge.target.node),
            targetNodeId: edge.target.node,
            promptId:
              edge.prompt === undefined
                ? null
                : promptId(
                    edge.prompt,
                    `${location}.workflow.nodes.${nodeId}.edges.${outcome}.prompt`,
                  ),
            terminalBehavior: null,
          }),
        );
        continue;
      }
      if (edge.prompt !== undefined)
        throw new Error(
          `${location}.workflow.nodes.${nodeId}.edges.${outcome} cannot have a terminal transition prompt.`,
        );
      const requiredNames = new Set(requirements.map((item) => item.definition.name));
      const exportRecords = edge.target.export_records.map((raw) => {
        const name = parseRecordName(raw);
        const definition = requirements.find((item)=>item.definition.name===name)?.definition;
        if (!requiredNames.has(name))
          throw new Error(
            `${location}.workflow.nodes.${nodeId}.edges.${outcome} exports '${name}' without a source-node requirement.`,
          );
        return definition!;
      });
      const promotion =
        edge.target.promote === 'current'
          ? Object.freeze({ kind: 'current' as const })
          : Object.freeze({
              kind: 'latest-node' as const,
              nodeId: edge.target.promote.latest_node,
            });
      edges.set(
        outcome,
        Object.freeze({
          outcome,
          targetStateId: terminalState(edge.target.terminal),
          targetNodeId: null,
          promptId: null,
          terminalBehavior: Object.freeze({
            promotion,
            exportRecords: Object.freeze(exportRecords),
          }),
        }),
      );
    }
    if (edges.size === 0)
      throw new Error(`${location}.workflow.nodes.${nodeId}.edges must not be empty.`);
    const descendantContext = node.descendant_context
      ? Object.freeze({
          records: Object.freeze(
            node.descendant_context.records.map((raw) => {
              const name = parseRecordName(raw);
              const record = records.get(name);
              if (!record)
                throw new Error(
                  `${location}.workflow.nodes.${nodeId}.descendant_context references unknown record '${name}'.`,
                );
              return record;
            }),
          ),
          requireUnchangedUntilAccept: node.descendant_context.require_unchanged_until_accept,
        })
      : null;
    const selectedAgentPrompt = selectAgentPrompt({kind:'workflow-agent',cardType}, agent, roots);
    nodes.set(
      nodeId,
      Object.freeze({
        nodeId,
        agent,
        selectedAgentPrompt,
        promptId: promptId(node.prompt, `${location}.workflow.nodes.${nodeId}.prompt`),
        correctionPromptId: promptId(
          node.correction_prompt,
          `${location}.workflow.nodes.${nodeId}.correction_prompt`,
        ),
        requirements: Object.freeze(requirements),
        descendantContext,
        edges: immutableMap(edges),
        childCreationTypes:
          agent.canCreateChildren && agent.tools.some((tool) => tool.name === 'create_card')
            ? permittedChildTypes
            : immutableSet([]),
        childActivationTypes: agent.tools.some((tool) => tool.name === 'activate_card')
          ? permittedChildTypes
          : immutableSet([]),
      }),
    );
  }
  if (nodes.size === 0) throw new Error(`${location}.workflow.nodes must not be empty.`);
  const entries = new Map<
    CardProcessEntry,
    Readonly<{ targetNodeId: string; promptId: ProcessPromptId | null }>
  >();
  for (const entry of ENTRY_PORTS) {
    const value = source.workflow.entries[entry];
    entries.set(
      entry,
      Object.freeze({
        targetNodeId: value.node,
        promptId:
          value.prompt === undefined
            ? null
            : promptId(value.prompt, `${location}.workflow.entries.${entry}.prompt`),
      }),
    );
  }
  return Object.freeze({
    cardType,
    location,
    permittedChildTypes,
    records,
    bootstrapRecord,
    nodes: immutableMap(nodes),
    entries: immutableMap(entries),
  });
}
function validateCardTypeTopology(draft: CardTypeCompileDraft): void {
  for (const [nodeId, node] of draft.nodes)
    for (const edge of node.edges.values())
      if (edge.targetNodeId !== null && !draft.nodes.has(edge.targetNodeId))
        throw new Error(
          `${draft.location}.workflow.nodes.${nodeId} targets missing node '${edge.targetNodeId}'.`,
        );
  for (const [entry, route] of draft.entries)
    if (!draft.nodes.has(route.targetNodeId))
      throw new Error(
        `${draft.location}.workflow.entries.${entry} targets missing node '${route.targetNodeId}'.`,
      );
  const reachable = new Set<string>();
  const visit = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const edge of draft.nodes.get(id)!.edges.values())
      if (edge.targetNodeId !== null) visit(edge.targetNodeId);
  };
  for (const route of draft.entries.values()) visit(route.targetNodeId);
  for (const id of draft.nodes.keys())
    if (!reachable.has(id))
      throw new Error(`${draft.location}.workflow.nodes.${id} is unreachable from every entry.`);
  const terminalReachable = new Set<string>();
  for (const [id, node] of draft.nodes)
    if ([...node.edges.values()].some((edge) => edge.terminalBehavior !== null))
      terminalReachable.add(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of draft.nodes)
      if (
        !terminalReachable.has(id) &&
        [...node.edges.values()].some(
          (edge) => edge.targetNodeId !== null && terminalReachable.has(edge.targetNodeId),
        )
      ) {
        terminalReachable.add(id);
        changed = true;
      }
  }
  for (const id of draft.nodes.keys())
    if (!terminalReachable.has(id))
      throw new Error(`${draft.location}.workflow.nodes.${id} has no path to a terminal.`);
  const pathExists = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...draft.nodes.get(from)!.edges.values()].some(
      (edge) => edge.targetNodeId !== null && pathExists(edge.targetNodeId, to, seen),
    );
  };
  for (const [sourceId, node] of draft.nodes)
    for (const edge of node.edges.values()) {
      const promotion = edge.terminalBehavior?.promotion;
      if (promotion?.kind === 'latest-node') {
        if (!draft.nodes.has(promotion.nodeId))
          throw new Error(
            `${draft.location}.workflow.nodes.${sourceId}.edges.${edge.outcome} promotes missing node '${promotion.nodeId}'.`,
          );
        if (!pathExists(promotion.nodeId, sourceId))
          throw new Error(
            `${draft.location}.workflow.nodes.${sourceId}.edges.${edge.outcome} has no path from promoted node '${promotion.nodeId}' to its terminal source.`,
          );
      }
    }
}
function compiledProcessTransition(
  targetStateId: string,
  semantic: ProcessTransitionSemantic,
  reenter = false,
): CompiledProcessTransition {
  return Object.freeze({ targetStateId, reenter, semantic });
}
function buildCardTypeStateTable(
  draft: CardTypeCompileDraft,
  roots: PromptRoots,
): CompiledCardTypeWorkflow {
  const stateEntries: Array<readonly [string, CompiledProcessState]> = [];
  const readyOn = new Map<string, CompiledProcessTransition>();
  for (const entry of ENTRY_PORTS)
    readyOn.set(
      `activate:${entry}`,
      compiledProcessTransition(entryState(entry), Object.freeze({ kind: 'activation' })),
    );
  stateEntries.push([
    'lifecycle:ready',
    Object.freeze({ kind: 'ready', on: immutableMap(readyOn), isTerminal: false, isParked: true }),
  ]);
  for (const entry of ENTRY_PORTS) {
    const route = draft.entries.get(entry)!;
    stateEntries.push([
      entryState(entry),
      Object.freeze({
        kind: 'entry',
        entry,
        on: immutableMap([
          [
            'entry:route',
            compiledProcessTransition(
              nodeState(route.targetNodeId),
              Object.freeze({ kind: 'entry-route', promptId: route.promptId }),
            ),
          ],
        ]),
        isTerminal: false,
        isParked: false,
      }),
    ]);
  }
  for (const [nodeId, node] of draft.nodes) {
    const stateId = nodeState(nodeId);
    const on = new Map<string, CompiledProcessTransition>();
    for (const edge of node.edges.values())
      on.set(
        `result:${edge.outcome}`,
        compiledProcessTransition(
          edge.targetStateId,
          Object.freeze({
            kind: 'configured-outcome',
            outcome: edge.outcome,
            promptId: edge.promptId,
            terminalBehavior: edge.terminalBehavior,
          }),
          edge.targetStateId === stateId,
        ),
      );
    on.set(
      'execution:failed',
      compiledProcessTransition(
        terminalState('FAILED'),
        Object.freeze({ kind: 'runtime-terminal', cause: 'failed' }),
      ),
    );
    on.set(
      'execution:blocked',
      compiledProcessTransition(
        terminalState('BLOCKED'),
        Object.freeze({ kind: 'runtime-terminal', cause: 'blocked' }),
      ),
    );
    stateEntries.push([
      stateId,
      Object.freeze({
        kind: 'node',
        nodeId,
        agent: node.agent,
        selectedAgentPrompt: node.selectedAgentPrompt,
        promptId: node.promptId,
        correctionPromptId: node.correctionPromptId,
        requirements: node.requirements,
        descendantContext: node.descendantContext,
        childCreationTypes: node.childCreationTypes,
        childActivationTypes: node.childActivationTypes,
        readableRecords: draft.records,
        on: immutableMap(on),
        isTerminal: false,
        isParked: false,
      }),
    ]);
  }
  for (const terminal of TERMINAL_PORTS)
    stateEntries.push([
      terminalState(terminal),
      Object.freeze({
        kind: 'terminal',
        terminal,
        on: immutableMap<string, CompiledProcessTransition>([]),
        isTerminal: true,
        isParked: false,
      }),
    ]);
  const states = immutableMap(stateEntries);
  validateCompiledActorTable('lifecycle:ready', states);
  validateProcessStateTable(draft.location, states);
  const ids = new Set<ProcessPromptId>();
  for (const state of states.values()) {
    if (state.kind === 'node') {
      ids.add(state.promptId);
      ids.add(state.correctionPromptId);
    }
    for (const route of state.on.values())
      if (
        (route.semantic.kind === 'entry-route' || route.semantic.kind === 'configured-outcome') &&
        route.semantic.promptId !== null
      )
        ids.add(route.semantic.promptId);
  }
  const processPrompts = immutableMap(
    [...ids].map((id) => [id, selectProcessPrompt(draft.cardType, id, roots)] as const),
  );
  return Object.freeze({
    cardType: draft.cardType,
    permittedChildTypes: draft.permittedChildTypes,
    records: draft.records,
    bootstrapRecord: draft.bootstrapRecord,
    initialStateId: 'lifecycle:ready',
    states,
    processPrompts,
  });
}
function validateProcessStateTable(
  location: string,
  states: ReadonlyMap<string, CompiledProcessState>,
): void {
  for (const [source, state] of states)
    for (const [event, route] of state.on) {
      const target = states.get(route.targetStateId)!;
      if (
        route.semantic.kind === 'activation' &&
        (state.kind !== 'ready' || target.kind !== 'entry' || event !== `activate:${target.entry}`)
      )
        throw new Error(
          `${location}.workflow transition '${source}'/'${event}' has invalid activation semantics.`,
        );
      if (
        route.semantic.kind === 'entry-route' &&
        (state.kind !== 'entry' || target.kind !== 'node' || event !== 'entry:route')
      )
        throw new Error(
          `${location}.workflow transition '${source}'/'${event}' has invalid entry semantics.`,
        );
      if (
        route.semantic.kind === 'runtime-terminal' &&
        (state.kind !== 'node' || target.kind !== 'terminal' || event !== `execution:${route.semantic.cause}`)
      )
        throw new Error(
          `${location}.workflow transition '${source}'/'${event}' has invalid runtime terminal semantics.`,
        );
      if (route.semantic.kind === 'configured-outcome') {
        if (
          state.kind !== 'node' ||
          (target.kind !== 'node' && target.kind !== 'terminal') ||
          event !== `result:${route.semantic.outcome}`
        )
          throw new Error(
            `${location}.workflow transition '${source}'/'${event}' has invalid configured outcome semantics.`,
          );
        if ((target.kind === 'terminal') !== (route.semantic.terminalBehavior !== null))
          throw new Error(
            `${location}.workflow transition '${source}'/'${event}' has incompatible terminal behavior.`,
          );
      }
    }
}
function validateDescendantContextClosure(drafts:ReadonlyMap<CardTypeName,CardTypeCompileDraft>):void{
  for(const [cardType,draft] of drafts){
    const reachable=new Set<CardTypeName>();
    const visit=(type:CardTypeName):void=>{const current=drafts.get(type);if(!current)throw new Error(`No compile draft exists for configured card type '${type}'.`);for(const child of current.permittedChildTypes){if(reachable.has(child))continue;reachable.add(child);visit(child);}};
    visit(cardType);
    for(const node of draft.nodes.values())for(const definition of node.descendantContext?.records??[]){
      for(const descendantType of reachable){const descendant=drafts.get(descendantType);if(!descendant)throw new Error(`No compile draft exists for configured card type '${descendantType}'.`);if(!descendant.records.has(definition.name))throw new Error(`${draft.location}.workflow.nodes.${node.nodeId}.descendant_context record '${definition.name}' is not declared by reachable descendant type '${descendantType}'.`);}
    }
  }
}

function validateParticipantCompletionReserve(config:SaivageConfig,analyst:CompiledAgentContract,drafts:ReadonlyMap<CardTypeName,CardTypeCompileDraft>):void{
  const budget=config.compaction.input_budget_tokens;
  const fraction=config.compaction.completion_reserve_fraction;
  const reserved=Math.floor(budget*fraction);
  const participants=new Map<AgentName,CompiledAgentContract>([[analyst.name,analyst]]);
  for(const draft of drafts.values())for(const node of draft.nodes.values())participants.set(node.agent.name,node.agent);
  const offenders:string[]=[];
  for(const [name,agent] of participants)if(agent.model.maxTokens>reserved)offenders.push(`agents.${name}.model_route '${agent.modelRoute}' requests max_tokens ${agent.model.maxTokens}, exceeding reserved completion tokens ${reserved} (floor(input_budget_tokens ${budget} * completion_reserve_fraction ${fraction}))`);
  if(offenders.length>0)throw new Error(`Configured workflow participants exceed the compaction completion reserve: ${offenders.join('; ')}.`);
}

export function compileProjectWorkflows(
  config: SaivageConfig,
  options: WorkflowCompileOptions = {},
): CompiledProjectWorkflows {
  const roots = promptRoots(options);
  const knownModels = new Set<string>();
  for (const routeName of Object.keys(config.models.routes))
    for (const model of resolveRoute(config, routeName)) knownModels.add(model);
  for (const group of config.models.equivalents) for (const model of group) knownModels.add(model);
  for (const [source, targets] of Object.entries(config.models.failover)) {
    if (!knownModels.has(source))
      throw new Error(`models.failover references unknown source model '${source}'.`);
    if (new Set(targets).size !== targets.length)
      throw new Error(`models.failover.${source} contains a duplicate model.`);
    for (const target of targets)
      if (!knownModels.has(target))
        throw new Error(`models.failover.${source} references unknown model '${target}'.`);
  }
  const agents = compileAgents(config);
  const analyst = agents.get(config.analyst_agent);
  if (!analyst)
    throw new Error(`analyst_agent references missing agent '${config.analyst_agent}'.`);
  if (analyst.session !== 'global') throw new Error('analyst_agent must use global session scope.');
  const analystPrompt = selectAgentPrompt({kind:'global-agent'}, analyst, roots);
  const sourceEntries = Object.entries(config.card_types).map(([rawCardType, source]) => [parseCardTypeName(rawCardType), source] as const);
  const cardTypeVocabulary = Object.freeze(sourceEntries.map(([cardType]) => cardType));
  if (!cardTypeVocabulary.includes('project')) throw new Error("card_types must contain the reserved 'project' entry.");
  const configuredCardTypes = immutableSet(cardTypeVocabulary);
  const drafts=immutableMap(sourceEntries.map(([type,source])=>[type,compileCardTypeInputs(type,source,agents,roots,configuredCardTypes)] as const));
  validateParticipantCompletionReserve(config,analyst,drafts);
  for(const draft of drafts.values())validateCardTypeTopology(draft);
  validateDescendantContextClosure(drafts);
  const cardTypes=immutableMap([...drafts].map(([type,draft])=>[type,buildCardTypeStateTable(draft,roots)] as const));
  return Object.freeze({ analyst, analystPrompt, agents, cardTypes, cardTypeVocabulary });
}
export function bindRuntimeWorkflows(
  structural: CompiledProjectWorkflows,
  router: ModelRouter,
): CompiledRuntimeWorkflows {
  const participants = new Map<AgentName, Readonly<{ agent: CompiledAgentContract; toolSet: BoundAgentToolSet; request: CapabilityRequest }>>();
  const analystToolSet = new BoundAgentToolSet(structural.analyst.tools);
  const analystRequest = Object.freeze(capabilityRequestForTools(analystToolSet.names));
  participants.set(structural.analyst.name, Object.freeze({ agent: structural.analyst, toolSet: analystToolSet, request: analystRequest }));
  for (const workflow of structural.cardTypes.values()) {
    for (const state of workflow.states.values()) {
      if (state.kind !== 'node') continue;
      const effectiveReferences=effectiveCardNodeToolReferences(state.agent.tools,state.childCreationTypes);
      const toolSet = new BoundAgentToolSet(state.agent.tools);
      const request = Object.freeze(capabilityRequestForTools([...effectiveReferences, TERMINAL_RESULT_TOOL_NAME]));
      const existing = participants.get(state.agent.name);
      if (existing && JSON.stringify(existing.request) !== JSON.stringify(request))
        throw new Error(`Agent '${state.agent.name}' has inconsistent node capability requests.`);
      participants.set(state.agent.name, Object.freeze({ agent: state.agent, toolSet, request }));
    }
  }
  const bindings: Array<readonly [AgentName, BoundAgentContract]> = [];
  for (const [name, participant] of participants) {
    const candidates = router.resolveModels(participant.agent.model.orderedModelIds, participant.request);
    if (candidates.length === 0)
      throw new Error(
        `Agent '${name}' model route '${participant.agent.modelRoute}' has no capability-compatible configured provider candidate.`,
      );
    bindings.push([name, Object.freeze({ contract: participant.agent, candidateChain: Object.freeze([...candidates]), toolSet: participant.toolSet, capabilityRequest: participant.request })]);
  }
  return Object.freeze({
    ...structural,
    runtimeBound: true as const,
    agentBindings: immutableMap(bindings),
  });
}
export function runtimeAgentBinding(workflows: CompiledRuntimeWorkflows, agentName: AgentName): BoundAgentContract {
  const binding = workflows.agentBindings.get(agentName);
  if (!binding) throw new Error(`Compiled startup artifact is missing binding for agent '${agentName}'.`);
  return binding;
}
export function processNodeOutcomes(
  process: CompiledCardTypeWorkflow,
  stateId: string,
): readonly string[] {
  const node = process.states.get(stateId);
  if (!node || node.kind !== 'node')
    throw new Error(`Workflow '${process.cardType}' has no node state '${stateId}'.`);
  return Object.freeze(
    [...node.on.values()].flatMap((route) =>
      route.semantic.kind === 'configured-outcome' ? [route.semantic.outcome] : [],
    ),
  );
}
export function nodeResultSchema(process: CompiledCardTypeWorkflow, stateId: string) {
  return z.object({ outcome: z.enum(processNodeOutcomes(process, stateId) as [string, ...string[]]), summary: z.string().trim().min(1).max(2000) }).strict();
}
export function nodeResultToolDefinition(process: CompiledCardTypeWorkflow, stateId: string): LlmToolDefinition {
  return { type: 'function', function: { name: TERMINAL_RESULT_TOOL_NAME, description: 'Emit the configured process-node result as the final action of this turn.', parameters: zodToJsonSchemaMini(nodeResultSchema(process, stateId)) as Record<string, unknown> } };
}
export function describeNodeResultContract(
  process: CompiledCardTypeWorkflow,
  stateId: string,
): string {
  const node=process.states.get(stateId);if(!node||node.kind!=='node')throw new Error(`Workflow '${process.cardType}' has no node state '${stateId}'.`);
  const requirements=node.requirements.length===0?'':` Required record gates: ${node.requirements.map(({definition,mode,gate})=>`${definition.name} (${mode} + ${gate})`).join(', ')}.`;
  return `Call emit_result with exactly two fields: outcome (one of: ${processNodeOutcomes(process, stateId).join(' | ')}) and summary (a trimmed non-empty string of at most 2000 characters).${requirements}`;
}
