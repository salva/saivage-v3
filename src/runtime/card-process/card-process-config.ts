import type { CardProcessSource, CardProcessesSource } from '../../agents/config-schema.js';
import { planningCardTypeValues, terminalCardTypeValues, type CardStatus, type CardType } from '../../schemas/index.js';
import { recordSlotDefinitionForFilename } from '../records/record-slots.js';

export type CardProcessFamily = 'planning' | 'terminal';
export type CardProcessEntry = 'BACKLOG' | 'CHANGED' | 'BLOCKED' | 'STOPPED';

export function cardProcessEntryForStatus(status: CardStatus): CardProcessEntry | null {
  if (status === 'backlog') return 'BACKLOG';
  if (status === 'changed') return 'CHANGED';
  if (status === 'blocked') return 'BLOCKED';
  if (status === 'stopped') return 'STOPPED';
  return null;
}
export type CardProcessTerminal = 'DONE' | 'BLOCKED' | 'FAILED';
export type ProcessRole = 'planner' | 'reviewer' | 'executor';
export type ProcessRecordFilename = 'brief.md' | 'status.md' | 'review.md';
export type ProcessPromptId = string & { readonly __processPromptId: unique symbol };

export interface CompiledProcessEntry {
  readonly targetNodeId: string;
  readonly promptId: ProcessPromptId | null;
}

export type CompiledEdgeTarget =
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'terminal'; readonly port: CardProcessTerminal };

export interface CompiledProcessEdge {
  readonly target: CompiledEdgeTarget;
  readonly promptId: ProcessPromptId | null;
}

export interface CompiledProcessNode {
  readonly id: string;
  readonly role: ProcessRole;
  readonly promptId: ProcessPromptId;
  readonly correctionPromptId: ProcessPromptId;
  readonly requiredRecords: readonly {
    readonly filename: ProcessRecordFilename;
    readonly updated: boolean;
  }[];
  readonly outcomes: readonly string[];
  readonly edges: ReadonlyMap<string, CompiledProcessEdge>;
}

export interface CompiledCardProcess {
  readonly family: CardProcessFamily;
  readonly entries: ReadonlyMap<CardProcessEntry, CompiledProcessEntry>;
  readonly nodes: ReadonlyMap<string, CompiledProcessNode>;
}

export type CompiledCardProcesses = Readonly<Record<CardProcessFamily, CompiledCardProcess>>;

const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
const OUTCOME_IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const ENTRY_PORTS = ['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'] as const;
class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;
  constructor(entries: Iterable<readonly [K, V]>) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }
  get size(): number { return this.#values.size; }
  get(key: K): V | undefined { return this.#values.get(key); }
  has(key: K): boolean { return this.#values.has(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#values[Symbol.iterator](); }
  get [Symbol.toStringTag](): string { return 'ImmutableMap'; }
}

function immutableMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new ImmutableMap(entries);
}

function identifier(value: string, location: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`${location} must be a lowercase process identifier of at most 64 characters.`);
  return value;
}

function promptId(value: string, location: string): ProcessPromptId {
  return identifier(value, location) as ProcessPromptId;
}

function outcomeIdentifier(value: string, location: string): string {
  if (!OUTCOME_IDENTIFIER.test(value)) throw new Error(`${location} must be a lowercase outcome identifier of at most 64 characters.`);
  return value;
}

function applicableCardTypes(family: CardProcessFamily): readonly CardType[] {
  return family === 'planning' ? planningCardTypeValues : terminalCardTypeValues;
}

function compileFamily(family: CardProcessFamily, source: CardProcessSource): CompiledCardProcess {
  const compatibleRoles: ReadonlySet<ProcessRole> = family === 'planning'
    ? new Set(['planner', 'reviewer'])
    : new Set(['executor']);
  const nodeEntries: Array<readonly [string, CompiledProcessNode]> = [];

  for (const [rawNodeId, rawNode] of Object.entries(source.nodes)) {
    const nodeId = identifier(rawNodeId, `card_processes.${family}.nodes key`);
    if (!compatibleRoles.has(rawNode.role)) throw new Error(`card_processes.${family}.nodes.${nodeId}.role '${rawNode.role}' is incompatible with the ${family} family.`);
    const recordNames = new Set<string>();
    const requiredRecords = rawNode.records.map((record, index) => {
      if (recordNames.has(record.name)) throw new Error(`card_processes.${family}.nodes.${nodeId}.records contains duplicate '${record.name}'.`);
      recordNames.add(record.name);
      if (record.updated && !recordSlotDefinitionForFilename(record.name).writers.includes(rawNode.role)) {
        throw new Error(`card_processes.${family}.nodes.${nodeId}.records.${index} requires ${rawNode.role} to update unsupported record '${record.name}'.`);
      }
      return Object.freeze({ filename: record.name, updated: record.updated });
    });
    const edgeEntries: Array<readonly [string, CompiledProcessEdge]> = [];
    for (const [rawOutcome, rawEdge] of Object.entries(rawNode.edges)) {
      const outcome = outcomeIdentifier(rawOutcome, `card_processes.${family}.nodes.${nodeId}.edges key`);
      const target: CompiledEdgeTarget = 'node' in rawEdge.target
        ? Object.freeze({ kind: 'node' as const, nodeId: identifier(rawEdge.target.node, `card_processes.${family}.nodes.${nodeId}.edges.${outcome}.target.node`) })
        : Object.freeze({ kind: 'terminal' as const, port: rawEdge.target.terminal });
      if (target.kind === 'terminal' && rawEdge.prompt !== undefined) {
        throw new Error(`card_processes.${family}.nodes.${nodeId}.edges.${outcome} cannot specify prompt for terminal target ${target.port}.`);
      }
      edgeEntries.push([outcome, Object.freeze({ target, promptId: rawEdge.prompt === undefined ? null : promptId(rawEdge.prompt, `card_processes.${family}.nodes.${nodeId}.edges.${outcome}.prompt`) })]);
    }
    if (edgeEntries.length === 0) throw new Error(`card_processes.${family}.nodes.${nodeId}.edges must contain at least one outcome.`);
    nodeEntries.push([nodeId, Object.freeze({
      id: nodeId,
      role: rawNode.role,
      promptId: promptId(rawNode.prompt, `card_processes.${family}.nodes.${nodeId}.prompt`),
      correctionPromptId: promptId(rawNode.correction_prompt, `card_processes.${family}.nodes.${nodeId}.correction_prompt`),
      requiredRecords: Object.freeze(requiredRecords),
      outcomes: Object.freeze(edgeEntries.map(([outcome]) => outcome)),
      edges: immutableMap(edgeEntries),
    })]);
  }
  if (nodeEntries.length === 0) throw new Error(`card_processes.${family}.nodes must contain at least one node.`);
  const nodes = immutableMap(nodeEntries);

  const entries = immutableMap(ENTRY_PORTS.map((port) => {
    const rawEntry = source.entries[port];
    const targetNodeId = identifier(rawEntry.node, `card_processes.${family}.entries.${port}.node`);
    if (!nodes.has(targetNodeId)) throw new Error(`card_processes.${family}.entries.${port} targets missing node '${targetNodeId}'.`);
    if (port === 'STOPPED' && rawEntry.prompt === undefined) throw new Error(`card_processes.${family}.entries.STOPPED.prompt is required.`);
    return [port, Object.freeze({ targetNodeId, promptId: rawEntry.prompt === undefined ? null : promptId(rawEntry.prompt, `card_processes.${family}.entries.${port}.prompt`) })] as const;
  }));

  for (const node of nodes.values()) {
    for (const edge of node.edges.values()) {
      if (edge.target.kind === 'node' && !nodes.has(edge.target.nodeId)) {
        throw new Error(`card_processes.${family}.nodes.${node.id} targets missing node '${edge.target.nodeId}'.`);
      }
    }
  }

  const reachable = new Set<string>();
  const visit = (nodeId: string): void => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    for (const edge of nodes.get(nodeId)!.edges.values()) if (edge.target.kind === 'node') visit(edge.target.nodeId);
  };
  for (const entry of entries.values()) visit(entry.targetNodeId);
  for (const nodeId of nodes.keys()) if (!reachable.has(nodeId)) throw new Error(`card_processes.${family}.nodes.${nodeId} is unreachable from every entry.`);

  const terminalReachable = new Set<string>();
  for (const node of nodes.values()) if ([...node.edges.values()].some((edge) => edge.target.kind === 'terminal')) terminalReachable.add(node.id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes.values()) {
      if (terminalReachable.has(node.id)) continue;
      if ([...node.edges.values()].some((edge) => edge.target.kind === 'node' && terminalReachable.has(edge.target.nodeId))) {
        terminalReachable.add(node.id);
        changed = true;
      }
    }
  }
  for (const nodeId of nodes.keys()) if (!terminalReachable.has(nodeId)) throw new Error(`card_processes.${family}.nodes.${nodeId} has no path to a terminal.`);

  return Object.freeze({ family, entries, nodes });
}

export function compileCardProcesses(source: CardProcessesSource): CompiledCardProcesses {
  return Object.freeze({
    planning: compileFamily('planning', source.planning),
    terminal: compileFamily('terminal', source.terminal),
  });
}

export function cardTypesForProcess(process: CompiledCardProcess): readonly CardType[] {
  return applicableCardTypes(process.family);
}

export function describeNodeResultContract(node: CompiledProcessNode): string {
  return `Call emit_result with exactly two fields: outcome (one of: ${node.outcomes.join(' | ')}) and summary (a trimmed non-empty string of at most 2000 characters).`;
}
