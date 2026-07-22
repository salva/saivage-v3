import type { CardProcessSource, CardProcessesSource } from '../../schemas/saivage-config.js';
import { planningCardTypeValues, terminalCardTypeValues, type CardStatus, type CardType } from '../../schemas/index.js';
import { compileActorDefinition, type CompiledActorDefinition, type CompiledTransitionDefinition } from '../micro-actor/index.js';
import { currentRecordDefinitionForFilename } from '../../records/current-record-definitions.js';

export type CardProcessFamily = 'planning' | 'terminal';
export type CardProcessEntry = 'BACKLOG' | 'CHANGED' | 'BLOCKED' | 'STOPPED';
export type CardProcessTerminal = 'DONE' | 'BLOCKED' | 'FAILED';
export type ProcessRole = 'planner' | 'reviewer' | 'executor';
export type ProcessRecordFilename = 'brief.md' | 'status.md' | 'review.md';
export type ProcessPromptId = string & { readonly __processPromptId: unique symbol };

export type ProcessStateMetadata =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'entry'; entry: CardProcessEntry }>
  | Readonly<{ kind: 'node'; nodeId: string; role: ProcessRole; promptId: ProcessPromptId; correctionPromptId: ProcessPromptId; requiredRecords: readonly Readonly<{ filename: ProcessRecordFilename; updated: boolean }>[] }>
  | Readonly<{ kind: 'terminal'; terminal: CardProcessTerminal }>;

export type ProcessNodeMetadata = Extract<ProcessStateMetadata, { kind: 'node' }>;

export type ProcessPosition =
  | Readonly<{ family: CardProcessFamily; stateId: string; kind: 'ready' }>
  | Readonly<{ family: CardProcessFamily; stateId: string; kind: 'entry'; entry: CardProcessEntry }>
  | Readonly<{ family: CardProcessFamily; stateId: string; kind: 'node'; nodeId: string; executionOrdinal: number }>
  | Readonly<{ family: CardProcessFamily; stateId: string; kind: 'terminal'; terminal: CardProcessTerminal }>;

export interface CompiledCardProcess {
  readonly family: CardProcessFamily;
  readonly definition: CompiledActorDefinition;
  readonly states: ReadonlyMap<string, ProcessStateMetadata>;
  readonly transitionPrompts: ReadonlyMap<string, ProcessPromptId>;
}

export type CompiledCardProcesses = Readonly<Record<CardProcessFamily, CompiledCardProcess>>;

const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
const OUTCOME_IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const ENTRY_PORTS = ['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'] as const;
const TERMINAL_PORTS = ['DONE', 'BLOCKED', 'FAILED'] as const;

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;
  constructor(entries: Iterable<readonly [K, V]>) { this.#values = new Map(entries); Object.freeze(this); }
  get size(): number { return this.#values.size; }
  get(key: K): V | undefined { return this.#values.get(key); }
  has(key: K): boolean { return this.#values.has(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void { for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#values[Symbol.iterator](); }
  get [Symbol.toStringTag](): string { return 'ImmutableMap'; }
}

function immutableMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> { return new ImmutableMap(entries); }
function identifier(value: string, location: string): string { if (!IDENTIFIER.test(value)) throw new Error(`${location} must be a lowercase process identifier of at most 64 characters.`); return value; }
function promptId(value: string, location: string): ProcessPromptId { return identifier(value, location) as ProcessPromptId; }
function outcomeIdentifier(value: string, location: string): string { if (!OUTCOME_IDENTIFIER.test(value)) throw new Error(`${location} must be a lowercase outcome identifier of at most 64 characters.`); return value; }
function nodeState(nodeId: string): string { return `node:${nodeId}`; }
function entryState(entry: CardProcessEntry): string { return `entry:${entry}`; }
function terminalState(terminal: CardProcessTerminal): string { return `terminal:${terminal}`; }

export function processTransitionPromptKey(source: string, event: string): string { return `${source.length}:${source}${event}`; }

export function cardProcessEntryForStatus(status: CardStatus): CardProcessEntry | null {
  if (status === 'backlog') return 'BACKLOG';
  if (status === 'changed') return 'CHANGED';
  if (status === 'blocked') return 'BLOCKED';
  if (status === 'stopped') return 'STOPPED';
  return null;
}

function applicableCardTypes(family: CardProcessFamily): readonly CardType[] { return family === 'planning' ? planningCardTypeValues : terminalCardTypeValues; }

type ValidatedEdge = Readonly<{ targetState: string; targetNodeId: string | null; terminal: CardProcessTerminal | null; promptId: ProcessPromptId | null }>;

function compileFamily(family: CardProcessFamily, source: CardProcessSource): CompiledCardProcess {
  const compatibleRoles: ReadonlySet<ProcessRole> = family === 'planning' ? new Set(['planner', 'reviewer']) : new Set(['executor']);
  const metadataEntries: Array<readonly [string, ProcessStateMetadata]> = [['lifecycle:ready', Object.freeze({ kind: 'ready' as const })]];
  const nodeSources = new Map<string, { metadata: ProcessNodeMetadata; edges: Map<string, ValidatedEdge> }>();

  for (const [rawNodeId, rawNode] of Object.entries(source.nodes)) {
    const nodeId = identifier(rawNodeId, `card_processes.${family}.nodes key`);
    if (!compatibleRoles.has(rawNode.role)) throw new Error(`card_processes.${family}.nodes.${nodeId}.role '${rawNode.role}' is incompatible with the ${family} family.`);
    const recordNames = new Set<string>();
    const requiredRecords = Object.freeze(rawNode.records.map((record, index) => {
      if (recordNames.has(record.name)) throw new Error(`card_processes.${family}.nodes.${nodeId}.records contains duplicate '${record.name}'.`);
      recordNames.add(record.name);
      if (record.updated && !currentRecordDefinitionForFilename(record.name).writers.includes(rawNode.role)) throw new Error(`card_processes.${family}.nodes.${nodeId}.records.${index} requires ${rawNode.role} to update unsupported record '${record.name}'.`);
      return Object.freeze({ filename: record.name, updated: record.updated });
    }));
    const edges = new Map<string, ValidatedEdge>();
    for (const [rawOutcome, rawEdge] of Object.entries(rawNode.edges)) {
      const outcome = outcomeIdentifier(rawOutcome, `card_processes.${family}.nodes.${nodeId}.edges key`);
      if ('node' in rawEdge.target) {
        const targetNodeId = identifier(rawEdge.target.node, `card_processes.${family}.nodes.${nodeId}.edges.${outcome}.target.node`);
        edges.set(outcome, Object.freeze({ targetState: nodeState(targetNodeId), targetNodeId, terminal: null, promptId: rawEdge.prompt === undefined ? null : promptId(rawEdge.prompt, `card_processes.${family}.nodes.${nodeId}.edges.${outcome}.prompt`) }));
      } else {
        if (rawEdge.prompt !== undefined) throw new Error(`card_processes.${family}.nodes.${nodeId}.edges.${outcome} cannot specify prompt for terminal target ${rawEdge.target.terminal}.`);
        edges.set(outcome, Object.freeze({ targetState: terminalState(rawEdge.target.terminal), targetNodeId: null, terminal: rawEdge.target.terminal, promptId: null }));
      }
    }
    if (edges.size === 0) throw new Error(`card_processes.${family}.nodes.${nodeId}.edges must contain at least one outcome.`);
    const metadata: ProcessNodeMetadata = Object.freeze({ kind: 'node', nodeId, role: rawNode.role, promptId: promptId(rawNode.prompt, `card_processes.${family}.nodes.${nodeId}.prompt`), correctionPromptId: promptId(rawNode.correction_prompt, `card_processes.${family}.nodes.${nodeId}.correction_prompt`), requiredRecords });
    nodeSources.set(nodeId, { metadata, edges });
    metadataEntries.push([nodeState(nodeId), metadata]);
  }
  if (nodeSources.size === 0) throw new Error(`card_processes.${family}.nodes must contain at least one node.`);

  const entryTargets = new Map<CardProcessEntry, string>();
  const promptEntries: Array<readonly [string, ProcessPromptId]> = [];
  for (const entry of ENTRY_PORTS) {
    const rawEntry = source.entries[entry];
    const targetNodeId = identifier(rawEntry.node, `card_processes.${family}.entries.${entry}.node`);
    if (!nodeSources.has(targetNodeId)) throw new Error(`card_processes.${family}.entries.${entry} targets missing node '${targetNodeId}'.`);
    if (entry === 'STOPPED' && rawEntry.prompt === undefined) throw new Error(`card_processes.${family}.entries.STOPPED.prompt is required.`);
    entryTargets.set(entry, targetNodeId);
    metadataEntries.push([entryState(entry), Object.freeze({ kind: 'entry', entry })]);
    if (rawEntry.prompt !== undefined) promptEntries.push([processTransitionPromptKey(entryState(entry), 'entry:route'), promptId(rawEntry.prompt, `card_processes.${family}.entries.${entry}.prompt`)]);
  }
  for (const terminal of TERMINAL_PORTS) metadataEntries.push([terminalState(terminal), Object.freeze({ kind: 'terminal', terminal })]);

  for (const [nodeId, node] of nodeSources) for (const edge of node.edges.values()) if (edge.targetNodeId && !nodeSources.has(edge.targetNodeId)) throw new Error(`card_processes.${family}.nodes.${nodeId} targets missing node '${edge.targetNodeId}'.`);

  const reachable = new Set<string>();
  const visit = (nodeId: string): void => { if (reachable.has(nodeId)) return; reachable.add(nodeId); for (const edge of nodeSources.get(nodeId)!.edges.values()) if (edge.targetNodeId) visit(edge.targetNodeId); };
  for (const target of entryTargets.values()) visit(target);
  for (const nodeId of nodeSources.keys()) if (!reachable.has(nodeId)) throw new Error(`card_processes.${family}.nodes.${nodeId} is unreachable from every entry.`);
  const terminalReachable = new Set<string>();
  for (const [nodeId, node] of nodeSources) if ([...node.edges.values()].some((edge) => edge.terminal !== null)) terminalReachable.add(nodeId);
  let changed = true;
  while (changed) { changed = false; for (const [nodeId, node] of nodeSources) if (!terminalReachable.has(nodeId) && [...node.edges.values()].some((edge) => edge.targetNodeId && terminalReachable.has(edge.targetNodeId))) { terminalReachable.add(nodeId); changed = true; } }
  for (const nodeId of nodeSources.keys()) if (!terminalReachable.has(nodeId)) throw new Error(`card_processes.${family}.nodes.${nodeId} has no path to a terminal.`);

  const states: Record<string, { parked?: boolean; terminal?: boolean; on?: Record<string, string | { target: string; reenter: true }> }> = { 'lifecycle:ready': { parked: true, on: {} } };
  for (const entry of ENTRY_PORTS) {
    states['lifecycle:ready']!.on![`activate:${entry}`] = entryState(entry);
    states[entryState(entry)] = { on: { 'entry:route': nodeState(entryTargets.get(entry)!) } };
  }
  for (const [nodeId, node] of nodeSources) {
    const stateId = nodeState(nodeId);
    const on: Record<string, string | { target: string; reenter: true }> = {};
    for (const [outcome, edge] of node.edges) {
      on[`result:${outcome}`] = edge.targetState === stateId ? { target: stateId, reenter: true } : edge.targetState;
      if (edge.promptId) promptEntries.push([processTransitionPromptKey(stateId, `result:${outcome}`), edge.promptId]);
    }
    on['execution:failed'] = terminalState('FAILED');
    states[stateId] = { on };
  }
  for (const terminal of TERMINAL_PORTS) states[terminalState(terminal)] = { terminal: true };
  const definition = compileActorDefinition({ initial: 'lifecycle:ready', states });
  const metadata = immutableMap(metadataEntries);
  if (definition.states.size !== metadata.size || [...definition.states.keys()].some((key) => !metadata.has(key))) throw new Error(`Compiled process '${family}' metadata does not match its actor definition.`);
  return Object.freeze({ family, definition, states: metadata, transitionPrompts: immutableMap(promptEntries) });
}

export function compileCardProcesses(source: CardProcessesSource): CompiledCardProcesses { return Object.freeze({ planning: compileFamily('planning', source.planning), terminal: compileFamily('terminal', source.terminal) }); }
export function cardTypesForProcess(process: CompiledCardProcess): readonly CardType[] { return applicableCardTypes(process.family); }

export function processNodeOutcomes(process: CompiledCardProcess, stateId: string): readonly string[] {
  const state = process.definition.states.get(stateId);
  if (!state || process.states.get(stateId)?.kind !== 'node') throw new Error(`Process '${process.family}' has no node state '${stateId}'.`);
  return Object.freeze([...state.on.keys()].filter((event) => event.startsWith('result:')).map((event) => event.slice('result:'.length)));
}

export function processNodeTransition(process: CompiledCardProcess, stateId: string, outcome: string): CompiledTransitionDefinition {
  const transition = process.definition.states.get(stateId)?.on.get(`result:${outcome}`);
  if (!transition) throw new Error(`Process '${process.family}' node state '${stateId}' has no outcome '${outcome}'.`);
  return transition;
}

export function describeNodeResultContract(process: CompiledCardProcess, stateId: string): string {
  return `Call emit_result with exactly two fields: outcome (one of: ${processNodeOutcomes(process, stateId).join(' | ')}) and summary (a trimmed non-empty string of at most 2000 characters).`;
}
