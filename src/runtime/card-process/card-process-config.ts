import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentName } from '../../schemas/agent-name.js';
import { parseRecordName, type RecordName } from '../../schemas/record-name.js';
import type { CardTypeSource, SaivageConfig } from '../../schemas/saivage-config.js';
import { cardTypeValues, type CardStatus, type CardType } from '../../schemas/index.js';
import { validateCompiledActorTable } from '../micro-actor/index.js';
import { validateCompiledAgentPrompt } from '../../utils/prompt-api.js';
import type { Candidate } from '../../contracts/provider-candidate.js';
import type { ModelRouter } from '../../agents/model-router.js';

export type CardProcessEntry = 'BACKLOG' | 'CHANGED' | 'BLOCKED' | 'STOPPED';
export type CardProcessTerminal = 'DONE' | 'BLOCKED' | 'FAILED';
export type ProcessPromptId = string & { readonly __processPromptId: unique symbol };
export type RecordRequirementKind = 'present' | 'updated';
export type CompiledAgentPrompt = Readonly<{ source: 'card-specific'|'generic-override'|'bundled'; reference:string; path:string; text:string }>;
export type CompiledProcessPrompt = Readonly<{ reference:ProcessPromptId; source:'override'|'bundled'; path:string; text:string }>;
export interface WorkflowCompileOptions { readonly projectRoot?:string; readonly defaultPromptRoot?:string; readonly overridePromptRoot?:string }

export type CompiledRecordDefinition = Readonly<{ name: RecordName; format: 'markdown'; schema: string; writers: readonly AgentName[]; bootstrap: boolean }>;
export type CompiledAgentContract = Readonly<{ name: AgentName; prompt: string; tools: readonly string[]; modelRoute: string; model: Readonly<{ candidates: readonly string[]; temperature: number; maxTokens: number }>; skills: boolean; session: 'global' | 'card'; canCreateChildren: boolean }>;
export type CompiledRecordRequirement = Readonly<{ definition: CompiledRecordDefinition; kind: RecordRequirementKind }>;
export type CompiledDescendantContext = Readonly<{ records: readonly CompiledRecordDefinition[]; requireUnchangedUntilAccept: boolean }>;
export type CompiledTerminalBehavior = Readonly<{ promotion: Readonly<{ kind: 'current' } | { kind: 'latest-node'; nodeId: string }>; exportRecords: readonly CompiledRecordDefinition[] }>;
export type ProcessTransitionSemantic =
  | Readonly<{ kind: 'activation' }>
  | Readonly<{ kind: 'entry-route'; promptId: ProcessPromptId | null }>
  | Readonly<{ kind: 'configured-outcome'; outcome: string; promptId: ProcessPromptId | null; terminalBehavior: CompiledTerminalBehavior | null }>
  | Readonly<{ kind: 'runtime-terminal'; cause: 'failed' | 'blocked' }>;
export type CompiledProcessTransition = Readonly<{ targetStateId: string; reenter: boolean; semantic: ProcessTransitionSemantic }>;
type ProcessStateBase = Readonly<{ on: ReadonlyMap<string, CompiledProcessTransition>; isTerminal: boolean; isParked: boolean }>;
export type CompiledNodeContract = ProcessStateBase & Readonly<{ kind: 'node'; nodeId: string; agent: CompiledAgentContract; selectedAgentPrompt:CompiledAgentPrompt; promptId: ProcessPromptId; correctionPromptId: ProcessPromptId; requirements: readonly CompiledRecordRequirement[]; descendantContext: CompiledDescendantContext | null; childCreationTypes: ReadonlySet<CardType>; childActivationTypes: ReadonlySet<CardType>; readableRecords: ReadonlyMap<RecordName, CompiledRecordDefinition>; writableRecords: ReadonlyMap<RecordName, CompiledRecordDefinition> }>;
export type CompiledProcessState =
  | (ProcessStateBase & Readonly<{ kind: 'ready' }>)
  | (ProcessStateBase & Readonly<{ kind: 'entry'; entry: CardProcessEntry }>)
  | CompiledNodeContract
  | (ProcessStateBase & Readonly<{ kind: 'terminal'; terminal: CardProcessTerminal }>);
export type ProcessPosition = Readonly<{ cardType: CardType; stateId: string; kind: 'ready' }> | Readonly<{ cardType: CardType; stateId: string; kind: 'entry'; entry: CardProcessEntry }> | Readonly<{ cardType: CardType; stateId: string; kind: 'node'; nodeId: string; executionOrdinal: number }> | Readonly<{ cardType: CardType; stateId: string; kind: 'terminal'; terminal: CardProcessTerminal }>;
export interface CompiledCardTypeWorkflow { readonly cardType: CardType; readonly permittedChildTypes: ReadonlySet<CardType>; readonly records: ReadonlyMap<RecordName, CompiledRecordDefinition>; readonly bootstrapRecord: CompiledRecordDefinition; readonly initialStateId: 'lifecycle:ready'; readonly states: ReadonlyMap<string, CompiledProcessState>; readonly processPrompts:ReadonlyMap<ProcessPromptId,CompiledProcessPrompt> }
export interface CompiledProjectWorkflows { readonly analyst: CompiledAgentContract; readonly analystPrompt:CompiledAgentPrompt; readonly agents: ReadonlyMap<AgentName, CompiledAgentContract>; readonly cardTypes: ReadonlyMap<CardType, CompiledCardTypeWorkflow> }
export interface CompiledRuntimeWorkflows extends CompiledProjectWorkflows { readonly runtimeBound: true;readonly candidateChains:ReadonlyMap<AgentName,readonly Candidate[]> }

const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u;
const OUTCOME_IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/u;
const ENTRY_PORTS = ['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'] as const;
const TERMINAL_PORTS = ['DONE', 'BLOCKED', 'FAILED'] as const;
const knownToolNames = new Set(['create_card', 'edit_card', 'cancel_card', 'activate_card', 'reorder_child', 'queue_notification', 'get_status', 'start_project', 'pause_runtime', 'resume_runtime', 'stop_project', 'restart_server', 'navigate_workspace', 'navigate_back', 'show_config', 'reconfigure', 'mcp_reconcile', 'read_runtime_events', 'read_runtime_errors', 'read_control_actions', 'list_processes_tool', 'list_agent_sessions', 'read_agent_session', 'delete_card', 'list_cards', 'get_card', 'get_tree', 'list_card_history', 'get_card_history_entry', 'diff_card', 'read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'websearch', 'webfetch', 'skill', 'mcp_tool_call']);

class ImmutableMap<K, V> implements ReadonlyMap<K, V> { readonly #values: Map<K,V>; constructor(entries: Iterable<readonly [K,V]>) { this.#values = new Map(entries); Object.freeze(this); } get size(){return this.#values.size;} get(key:K){return this.#values.get(key);} has(key:K){return this.#values.has(key);} entries(){return this.#values.entries();} keys(){return this.#values.keys();} values(){return this.#values.values();} forEach(callbackfn:(value:V,key:K,map:ReadonlyMap<K,V>)=>void,thisArg?:unknown){for(const [k,v] of this.#values) callbackfn.call(thisArg,v,k,this);} [Symbol.iterator](){return this.#values[Symbol.iterator]();} get [Symbol.toStringTag](){return 'ImmutableMap';} }
class ImmutableSet<T> implements ReadonlySet<T> { readonly #values:Set<T>; constructor(values:Iterable<T>){this.#values=new Set(values);Object.freeze(this);} get size(){return this.#values.size;} has(value:T){return this.#values.has(value);} entries(){return this.#values.entries();} keys(){return this.#values.keys();} values(){return this.#values.values();} forEach(callbackfn:(value:T,value2:T,set:ReadonlySet<T>)=>void,thisArg?:unknown){for(const value of this.#values)callbackfn.call(thisArg,value,value,this);} [Symbol.iterator](){return this.#values[Symbol.iterator]();} get [Symbol.toStringTag](){return 'ImmutableSet';} }
const immutableMap=<K,V>(entries:Iterable<readonly [K,V]>):ReadonlyMap<K,V>=>new ImmutableMap(entries);
const immutableSet=<T>(values:Iterable<T>):ReadonlySet<T>=>new ImmutableSet(values);
function bundledPromptRoot():string{const moduleDir=dirname(fileURLToPath(import.meta.url));const source=join(moduleDir,'..','..','prompts');return existsSync(source)?source:join(moduleDir,'..','..','..','prompts');}
function promptRoots(options:WorkflowCompileOptions):{defaultRoot:string;overrideRoot:string|undefined}{return{defaultRoot:options.defaultPromptRoot??bundledPromptRoot(),overrideRoot:options.overridePromptRoot??(options.projectRoot?join(options.projectRoot,'.saivage','config','prompts'):undefined)};}
function readUtf8(path:string):string{const text=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path));if(text.trim().length===0)throw new Error(`Prompt artifact '${path}' must contain non-whitespace UTF-8 text.`);return text;}
function readOptional(path:string):string|null{try{return readUtf8(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
function selectAgentPrompt(
  cardType: CardType | 'global',
  agent: CompiledAgentContract,
  roots: { defaultRoot: string; overrideRoot: string | undefined },
): CompiledAgentPrompt {
  if (cardType !== 'global' && roots.overrideRoot) {
    const path = join(roots.overrideRoot, cardType, 'agents', `${agent.name}.md`);
    const text = readOptional(path);
    if (text !== null)
      return Object.freeze({
        source: 'card-specific',
        reference: agent.prompt,
        path,
        text,
      });
  }
  if (roots.overrideRoot) {
    const path = join(roots.overrideRoot, 'agents', `${agent.name}.md`);
    const text = readOptional(path);
    if (text !== null)
      return Object.freeze({
        source: 'generic-override',
        reference: agent.prompt,
        path,
        text,
      });
  }
  const path = join(roots.defaultRoot, 'agents', `${agent.prompt}.md`);
  return Object.freeze({
    source: 'bundled',
    reference: agent.prompt,
    path,
    text: readUtf8(path),
  });
}
function selectProcessPrompt(
  cardType: CardType,
  id: ProcessPromptId,
  roots: { defaultRoot: string; overrideRoot: string | undefined },
): CompiledProcessPrompt {
  if (roots.overrideRoot) {
    const path = join(roots.overrideRoot, cardType, 'process', `${id}.md`);
    const text = readOptional(path);
    if (text !== null)
      return Object.freeze({ reference: id, source: 'override', path, text });
  }
  const path = join(roots.defaultRoot, cardType, 'process', `${id}.md`);
  return Object.freeze({ reference: id, source: 'bundled', path, text: readUtf8(path) });
}
function identifier(value:string,location:string):string { if(!IDENTIFIER.test(value))throw new Error(`${location} must be a lowercase identifier of at most 64 characters.`);return value; }
function promptId(value:string,location:string):ProcessPromptId{return identifier(value,location) as ProcessPromptId;}
function outcomeIdentifier(value:string,location:string):string{if(!OUTCOME_IDENTIFIER.test(value))throw new Error(`${location} must be a lowercase outcome identifier of at most 64 characters.`);return value;}
const nodeState=(id:string)=>`node:${id}`; const entryState=(entry:CardProcessEntry)=>`entry:${entry}`; const terminalState=(terminal:CardProcessTerminal)=>`terminal:${terminal}`;
export function cardProcessEntryForStatus(status:CardStatus):CardProcessEntry|null{if(status==='backlog')return'BACKLOG';if(status==='changed')return'CHANGED';if(status==='blocked')return'BLOCKED';if(status==='stopped')return'STOPPED';return null;}

function resolveRoute(config:SaivageConfig,name:string):readonly string[]{const route=config.models.routes[name];if(!route)throw new Error(`models.routes.${name} is missing.`);if(route.candidates){if(new Set(route.candidates).size!==route.candidates.length)throw new Error(`models.routes.${name}.candidates contains a duplicate.`);return Object.freeze([...route.candidates]);}const profile=config.models.profiles[route.profile!];if(!profile)throw new Error(`models.routes.${name}.profile references missing profile '${route.profile}'.`);const candidates=[...profile.preferred,...profile.allowed];if(candidates.length===0)throw new Error(`models.routes.${name}.profile resolves to no candidates.`);if(new Set(candidates).size!==candidates.length)throw new Error(`models.profiles.${route.profile} contains a duplicate candidate.`);return Object.freeze(candidates);}
function compileAgents(config:SaivageConfig):ReadonlyMap<AgentName,CompiledAgentContract>{const result:Array<readonly[AgentName,CompiledAgentContract]>=[];for(const[rawName,source]of Object.entries(config.agents)){const name=rawName as AgentName;const duplicate=new Set<string>();for(const tool of source.tools){if(duplicate.has(tool))throw new Error(`agents.${name}.tools contains duplicate '${tool}'.`);duplicate.add(tool);if(!knownToolNames.has(tool))throw new Error(`agents.${name}.tools contains unknown tool '${tool}'.`);}if(source.skills!==source.tools.includes('skill'))throw new Error(`agents.${name}.skills must agree with the skill tool.`);if(source.tools.includes('create_card')&&!source.can_create_children)throw new Error(`agents.${name} cannot list create_card when can_create_children is false.`);const route=config.models.routes[source.model_route];if(!route)throw new Error(`agents.${name}.model_route references missing route '${source.model_route}'.`);result.push([name,Object.freeze({name,prompt:source.prompt,tools:Object.freeze([...source.tools]),modelRoute:source.model_route,model:Object.freeze({candidates:resolveRoute(config,source.model_route),temperature:route.temperature,maxTokens:route.max_tokens}),skills:source.skills,session:source.session,canCreateChildren:source.can_create_children})]);}return immutableMap(result);}

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
  childCreationTypes: ReadonlySet<CardType>;
  childActivationTypes: ReadonlySet<CardType>;
  writableRecords: ReadonlyMap<RecordName, CompiledRecordDefinition>;
}>;
type CardTypeCompileDraft = Readonly<{
  cardType: CardType;
  location: string;
  permittedChildTypes: ReadonlySet<CardType>;
  records: ReadonlyMap<RecordName, CompiledRecordDefinition>;
  bootstrapRecord: CompiledRecordDefinition;
  nodes: ReadonlyMap<string, ProcessNodeDraft>;
  entries: ReadonlyMap<
    CardProcessEntry,
    Readonly<{ targetNodeId: string; promptId: ProcessPromptId | null }>
  >;
}>;

function compileCardTypeInputs(
  cardType: CardType,
  source: CardTypeSource,
  agents: ReadonlyMap<AgentName, CompiledAgentContract>,
  roots: { defaultRoot: string; overrideRoot: string | undefined },
): CardTypeCompileDraft {
  const location = `card_types.${cardType}`;
  const children = new Set<CardType>();
  for (const child of source.permitted_child_types) {
    if (child === 'project')
      throw new Error(`${location}.permitted_child_types cannot contain project.`);
    if (children.has(child))
      throw new Error(`${location}.permitted_child_types contains duplicate '${child}'.`);
    children.add(child);
  }
  const permittedChildTypes = immutableSet(children);
  const recordEntries: Array<readonly [RecordName, CompiledRecordDefinition]> = [];
  let bootstrapRecord: CompiledRecordDefinition | null = null;
  for (const [rawName, value] of Object.entries(source.records)) {
    const name = parseRecordName(rawName);
    if (new Set(value.writers).size !== value.writers.length)
      throw new Error(`${location}.records.${name}.writers contains a duplicate.`);
    for (const writer of value.writers)
      if (!agents.has(writer))
        throw new Error(
          `${location}.records.${name}.writers references missing agent '${writer}'.`,
        );
    const definition = Object.freeze({
      name,
      format: value.format,
      schema: value.schema,
      writers: Object.freeze([...value.writers]),
      bootstrap: value.bootstrap,
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
    for (const [rawRecord, kind] of Object.entries(node.records)) {
      const name = parseRecordName(rawRecord);
      const definition = records.get(name);
      if (!definition)
        throw new Error(
          `${location}.workflow.nodes.${nodeId}.records references unknown record '${name}'.`,
        );
      if (
        kind === 'updated' &&
        (!definition.writers.includes(agent.name) ||
          !agent.tools.includes('write') ||
          !agent.tools.includes('edit'))
      )
        throw new Error(
          `${location}.workflow.nodes.${nodeId}.records.${name} requires writer authority plus write and edit tools.`,
        );
      requirements.push(Object.freeze({ definition, kind }));
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
        const definition = records.get(name);
        if (!definition)
          throw new Error(
            `${location}.workflow.nodes.${nodeId}.edges.${outcome} exports unknown record '${name}'.`,
          );
        if (!requiredNames.has(name))
          throw new Error(
            `${location}.workflow.nodes.${nodeId}.edges.${outcome} exports '${name}' without a source-node present or updated requirement.`,
          );
        return definition;
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
    const selectedAgentPrompt = selectAgentPrompt(cardType, agent, roots);
    validateCompiledAgentPrompt(cardType, agent.name, selectedAgentPrompt, true);
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
          agent.canCreateChildren && agent.tools.includes('create_card')
            ? permittedChildTypes
            : immutableSet([]),
        childActivationTypes: agent.tools.includes('activate_card')
          ? permittedChildTypes
          : immutableSet([]),
        writableRecords: immutableMap(
          recordEntries.filter(([, record]) => record.writers.includes(agent.name)),
        ),
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
  roots: { defaultRoot: string; overrideRoot: string | undefined },
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
        writableRecords: node.writableRecords,
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
function compileCardType(
  cardType: CardType,
  source: CardTypeSource,
  agents: ReadonlyMap<AgentName, CompiledAgentContract>,
  roots: { defaultRoot: string; overrideRoot: string | undefined },
): CompiledCardTypeWorkflow {
  const draft = compileCardTypeInputs(cardType, source, agents, roots);
  validateCardTypeTopology(draft);
  return buildCardTypeStateTable(draft, roots);
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
  const analystPrompt = selectAgentPrompt('global', analyst, roots);
  validateCompiledAgentPrompt('global', analyst.name, analystPrompt, false);
  const sourceKeys = Object.keys(config.card_types);
  if (
    sourceKeys.length !== cardTypeValues.length ||
    cardTypeValues.some((type) => !(type in config.card_types))
  )
    throw new Error(`card_types must contain exactly: ${cardTypeValues.join(', ')}.`);
  const cardTypes = immutableMap(
    cardTypeValues.map(
      (type) => [type, compileCardType(type, config.card_types[type]!, agents, roots)] as const,
    ),
  );
  return Object.freeze({ analyst, analystPrompt, agents, cardTypes });
}
export function bindRuntimeWorkflows(
  structural: CompiledProjectWorkflows,
  router: ModelRouter,
): CompiledRuntimeWorkflows {
  const chains: Array<readonly [AgentName, readonly Candidate[]]> = [];
  for (const agent of structural.agents.values()) {
    const candidates = router.resolve(agent.name, { requiresTools: agent.tools.length > 0 });
    if (candidates.length === 0)
      throw new Error(
        `Agent '${agent.name}' model route '${agent.modelRoute}' has no capability-compatible configured provider candidate.`,
      );
    chains.push([agent.name, Object.freeze([...candidates])]);
  }
  return Object.freeze({
    ...structural,
    runtimeBound: true as const,
    candidateChains: immutableMap(chains),
  });
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
export function describeNodeResultContract(
  process: CompiledCardTypeWorkflow,
  stateId: string,
): string {
  return `Call emit_result with exactly two fields: outcome (one of: ${processNodeOutcomes(process, stateId).join(' | ')}) and summary (a trimmed non-empty string of at most 2000 characters).`;
}
