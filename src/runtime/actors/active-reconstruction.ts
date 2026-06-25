import { z } from 'zod';
import { operationalAgentRoleValues } from '../../schemas/index.js';
import type { OperationalAgentRole } from '../../schemas/index.js';
import type { ToolDefinition } from '../../agents/llm-contracts.js';
import type { CapabilityRequest } from '../../agents/provider-capabilities.js';
import type { CardActivationCaller } from './card-actor.js';
import { llmActorRoleSchema } from './actor-vocabulary.js';
import { parseCardActorId, parseLlmActorId, parseProcessorActorId, processorActorId } from './ids.js';
import type { LlmInvocationInput } from './llm-invocation.js';
import type { ActorSnapshotRecord } from './snapshots.js';

export type ActiveReconstructionRecord =
  | CardActiveReconstructionRecord
  | ProcessorActiveReconstructionRecord
  | LlmActiveReconstructionRecord;

export interface CardActiveReconstructionRecord {
  schema_version: 1;
  kind: 'card_activation';
  card_id: string;
  processor_actor_id: string;
  caller: CardActivationCaller;
  started_at: string;
}

export interface ProcessorActiveReconstructionRecord {
  schema_version: 1;
  kind: 'processor_activation';
  processor_kind: 'planning' | 'terminal';
  card_id: string;
  caller: CardActivationCaller;
  activation_counter: number;
  started_at: string;
}

export interface LlmActiveReconstructionRecord {
  schema_version: 1;
  kind: 'llm_turn';
  agent_id: string;
  role: OperationalAgentRole;
  card_id: string;
  input_id: string;
  input: LlmInvocationInput;
  provider_call_id: string | null;
  waiting_tool_call: {
    sourceInputId: string;
    toolCallId: string;
    toolName: string;
  } | null;
  delivered_tool_call_ids: string[];
  tool_delivery_counter: number;
  started_at: string;
}

const cardActivationCallerSchema: z.ZodType<CardActivationCaller> = z.union([
  z.object({ kind: z.literal('root'), cardId: z.string().optional(), sessionId: z.string().nullable().optional() }).strict(),
  z.object({ kind: z.literal('parent'), cardId: z.string().min(1), sessionId: z.string().nullable().optional() }).strict(),
]);

const cardActiveReconstructionSchema: z.ZodType<CardActiveReconstructionRecord> = z.object({
  schema_version: z.literal(1),
  kind: z.literal('card_activation'),
  card_id: z.string().min(1),
  processor_actor_id: z.string().min(1),
  caller: cardActivationCallerSchema,
  started_at: z.string().datetime(),
}).strict();

const processorActiveReconstructionSchema: z.ZodType<ProcessorActiveReconstructionRecord> = z.object({
  schema_version: z.literal(1),
  kind: z.literal('processor_activation'),
  processor_kind: z.enum(['planning', 'terminal']),
  card_id: z.string().min(1),
  caller: cardActivationCallerSchema,
  activation_counter: z.number().int().nonnegative(),
  started_at: z.string().datetime(),
}).strict();

const waitingToolCallSchema: z.ZodType<LlmActiveReconstructionRecord['waiting_tool_call']> = z.object({
  sourceInputId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
}).strict().nullable();

const llmInvocationInputSchema: z.ZodType<LlmInvocationInput> = z.object({
  inputId: z.string().min(1),
  agentId: z.string().min(1),
  role: z.enum(operationalAgentRoleValues),
  sessionId: z.string().min(1),
  systemPrompt: z.string(),
  contextMessages: z.array(z.unknown()),
  tools: z.array(z.custom<ToolDefinition>((value) => typeof value === 'object' && value !== null)),
  terminalToolNames: z.array(z.string()),
  modelParams: z.object({ temperature: z.number().optional(), maxTokens: z.number().optional() }).strict(),
  capabilityRequest: z.custom<CapabilityRequest>((value) => typeof value === 'object' && value !== null),
  episodeContext: z.record(z.unknown()),
}).strict();

const llmActiveReconstructionSchema: z.ZodType<LlmActiveReconstructionRecord> = z.object({
  schema_version: z.literal(1),
  kind: z.literal('llm_turn'),
  agent_id: z.string().min(1),
  role: llmActorRoleSchema,
  card_id: z.string().min(1),
  input_id: z.string().min(1),
  input: llmInvocationInputSchema,
  provider_call_id: z.string().min(1).nullable(),
  waiting_tool_call: waitingToolCallSchema,
  delivered_tool_call_ids: z.array(z.string().min(1)),
  tool_delivery_counter: z.number().int().nonnegative(),
  started_at: z.string().datetime(),
}).strict();

export function readCardActiveReconstruction(snapshot: ActorSnapshotRecord): CardActiveReconstructionRecord | null {
  assertExpectedSnapshotKind(snapshot, 'card');
  const record = readRawActiveReconstruction(snapshot);
  if (!record) return null;
  const parsed = parseReconstruction(snapshot, 'card_activation', cardActiveReconstructionSchema);
  const cardId = parseCardActorId(snapshot.actor_id);
  if (parsed.card_id !== cardId) throw new Error(`Card active reconstruction mismatch for '${snapshot.actor_id}': record card_id '${parsed.card_id}' does not match actor id '${cardId}'.`);
  if (parsed.processor_actor_id !== processorActorId(cardId)) throw new Error(`Card active reconstruction mismatch for '${snapshot.actor_id}': processor_actor_id '${parsed.processor_actor_id}' does not match '${processorActorId(cardId)}'.`);
  return parsed;
}

export function readLlmActiveReconstruction(snapshot: ActorSnapshotRecord): LlmActiveReconstructionRecord | null {
  assertExpectedSnapshotKind(snapshot, 'llm');
  const record = readRawActiveReconstruction(snapshot);
  if (!record) return null;
  const parsed = parseReconstruction(snapshot, 'llm_turn', llmActiveReconstructionSchema);
  const identity = parseLlmActorId(snapshot.actor_id);
  if (parsed.agent_id !== snapshot.actor_id) throw new Error(`LLM active reconstruction mismatch for '${snapshot.actor_id}': agent_id '${parsed.agent_id}' does not match actor id.`);
  if (parsed.role !== identity.role) throw new Error(`LLM active reconstruction mismatch for '${snapshot.actor_id}': role '${parsed.role}' does not match actor role '${identity.role}'.`);
  if (parsed.card_id !== identity.cardId) throw new Error(`LLM active reconstruction mismatch for '${snapshot.actor_id}': card_id '${parsed.card_id}' does not match actor card '${identity.cardId}'.`);
  if (parsed.input.agentId !== parsed.agent_id) throw new Error(`LLM active reconstruction mismatch for '${snapshot.actor_id}': input agentId '${parsed.input.agentId}' does not match agent_id.`);
  if (parsed.input.role !== parsed.role) throw new Error(`LLM active reconstruction mismatch for '${snapshot.actor_id}': input role '${parsed.input.role}' does not match role '${parsed.role}'.`);
  if (parsed.input.inputId !== parsed.input_id) throw new Error(`LLM active reconstruction mismatch for '${snapshot.actor_id}': input inputId '${parsed.input.inputId}' does not match input_id '${parsed.input_id}'.`);
  return parsed;
}

export function readProcessorActiveReconstruction(snapshot: ActorSnapshotRecord): ProcessorActiveReconstructionRecord | null {
  assertExpectedSnapshotKind(snapshot, 'processor');
  const record = readRawActiveReconstruction(snapshot);
  if (!record) return null;
  const parsed = parseReconstruction(snapshot, 'processor_activation', processorActiveReconstructionSchema);
  const cardId = parseProcessorActorId(snapshot.actor_id);
  if (parsed.card_id !== cardId) throw new Error(`Processor active reconstruction mismatch for '${snapshot.actor_id}': card_id '${parsed.card_id}' does not match actor card '${cardId}'.`);
  return parsed;
}

function readRawActiveReconstruction(snapshot: ActorSnapshotRecord): unknown | null {
  const record = snapshot.context.active_reconstruction;
  if (record === null || record === undefined) return null;
  if (typeof record !== 'object') throw new Error(`Actor snapshot '${snapshot.actor_id}' has invalid active_reconstruction.`);
  return record;
}

function parseReconstruction<T>(snapshot: ActorSnapshotRecord, expectedKind: ActiveReconstructionRecord['kind'], schema: z.ZodType<T>): T {
  const record = readRawActiveReconstruction(snapshot);
  if (record === null) throw new Error(`Actor snapshot '${snapshot.actor_id}' has no active_reconstruction.`);
  const objectRecord = record as { kind?: unknown };
  if (objectRecord.kind !== expectedKind) {
    throw new Error(`Actor snapshot '${snapshot.actor_id}' active_reconstruction kind mismatch: expected '${expectedKind}', received '${String(objectRecord.kind)}'.`);
  }
  const result = schema.safeParse(record);
  if (!result.success) throw new Error(`Actor snapshot '${snapshot.actor_id}' has corrupt ${expectedKind} active_reconstruction: ${result.error.message}`);
  return result.data;
}

function assertExpectedSnapshotKind(snapshot: ActorSnapshotRecord, expectedKind: ActorSnapshotRecord['actor_kind']): void {
  if (snapshot.actor_kind !== expectedKind) throw new Error(`Actor snapshot '${snapshot.actor_id}' kind mismatch: expected '${expectedKind}', received '${snapshot.actor_kind}'.`);
}
