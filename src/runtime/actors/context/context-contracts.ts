import { createHash } from 'node:crypto';

import { canonicalJson } from '../../../schemas/index.js';

export type ContextStorage = 'durable' | 'activation_local';

export type ContextReplacement =
  | Readonly<{ kind: 'retain' }>
  | Readonly<{ kind: 'latest_snapshot'; key: string; contentSha256: string }>;

export type ContextAudience =
  | 'primary_and_summarizer'
  | 'summarizer_only'
  | 'evidence_only';

export type ContextEvidence =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'canonical_locator'; locator: string; sha256: string }>
  | Readonly<{
      kind: 'observational_query';
      tool: string;
      arguments: unknown;
      observed_sha256: string;
    }>;

export type CanonicalMessageSourceIdentity = Readonly<{
  kind: 'conversation_message';
  sessionId: string;
  messageId: string;
}>;

export type CanonicalToolExchangeIdentity = Readonly<{
  kind: 'tool_exchange';
  sessionId: string;
  sourceInputId: string;
  toolCallId: string;
}>;

export type CanonicalSourceIdentity =
  | CanonicalMessageSourceIdentity
  | CanonicalToolExchangeIdentity;

export type ToolCallCompositeIdentity = Readonly<{
  sourceInputId: string;
  toolCallId: string;
}>;

export type ContextBlock = Readonly<{
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  storage: ContextStorage;
  replacement: ContextReplacement;
  audience: ContextAudience;
  evidence: ContextEvidence;
  canonicalSource: CanonicalSourceIdentity | null;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const CONTEXT_BLOCK_KEYS = Object.freeze([
  'id',
  'role',
  'content',
  'storage',
  'replacement',
  'audience',
  'evidence',
  'canonicalSource',
] as const);

export function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function contextBlockContentSha256(content: string): string {
  return sha256Utf8(content);
}

export function canonicalSourceIdentityKey(identity: CanonicalSourceIdentity): string {
  validateCanonicalSourceIdentity(identity);
  return canonicalJson(identity);
}

export function toolCallCompositeIdentityKey(identity: ToolCallCompositeIdentity): string {
  exactKeys(identity, ['sourceInputId', 'toolCallId'], 'tool-call composite identity');
  nonEmpty(identity.sourceInputId, 'tool-call sourceInputId');
  nonEmpty(identity.toolCallId, 'tool-call toolCallId');
  return canonicalJson(identity);
}

export function validateContextBlock(block: ContextBlock): void {
  exactKeys(block, CONTEXT_BLOCK_KEYS, `context block '${String(block.id)}'`);
  nonEmpty(block.id, 'context block id');
  if (!['system', 'user', 'assistant', 'tool'].includes(block.role))
    throw new Error(`Context block '${block.id}' has invalid role '${String(block.role)}'.`);
  if (typeof block.content !== 'string')
    throw new Error(`Context block '${block.id}' content must be a string.`);
  if (block.storage !== 'durable' && block.storage !== 'activation_local')
    throw new Error(`Context block '${block.id}' has invalid storage '${String(block.storage)}'.`);
  validateReplacement(block);
  if (!['primary_and_summarizer', 'summarizer_only', 'evidence_only'].includes(block.audience))
    throw new Error(`Context block '${block.id}' has invalid audience '${String(block.audience)}'.`);
  validateEvidence(block);
  if (block.canonicalSource !== null) validateCanonicalSourceIdentity(block.canonicalSource);
  if (block.storage === 'activation_local' && block.canonicalSource !== null)
    throw new Error(`Activation-local context block '${block.id}' cannot claim a canonical source.`);
  if (block.storage === 'durable' && block.canonicalSource === null)
    throw new Error(`Durable context block '${block.id}' requires a canonical source.`);
}

export function selectLatestContextSnapshots(blocks: readonly ContextBlock[]): readonly ContextBlock[] {
  const latest = new Map<string, number>();
  blocks.forEach((block, index) => {
    validateContextBlock(block);
    if (block.replacement.kind === 'latest_snapshot') latest.set(block.replacement.key, index);
  });
  return Object.freeze(blocks.filter((block, index) =>
    block.replacement.kind === 'retain' || latest.get(block.replacement.key) === index));
}

export function dynamicBlocksSha256(blocks: readonly ContextBlock[]): string {
  blocks.forEach(validateContextBlock);
  return sha256Utf8(canonicalJson(blocks));
}

function validateReplacement(block: ContextBlock): void {
  const replacement = block.replacement;
  if (replacement.kind === 'retain') {
    exactKeys(replacement, ['kind'], `context block '${block.id}' retain replacement`);
    return;
  }
  if (replacement.kind !== 'latest_snapshot')
    throw new Error(`Context block '${block.id}' has invalid replacement kind.`);
  exactKeys(replacement, ['kind', 'key', 'contentSha256'], `context block '${block.id}' snapshot replacement`);
  nonEmpty(replacement.key, `context block '${block.id}' snapshot key`);
  sha256(replacement.contentSha256, `context block '${block.id}' contentSha256`);
  const actual = contextBlockContentSha256(block.content);
  if (actual !== replacement.contentSha256)
    throw new Error(`Context block '${block.id}' contentSha256 mismatch: expected ${replacement.contentSha256}, got ${actual}.`);
}

function validateEvidence(block: ContextBlock): void {
  const evidence = block.evidence;
  if (evidence.kind === 'none') {
    exactKeys(evidence, ['kind'], `context block '${block.id}' none evidence`);
    return;
  }
  if (evidence.kind === 'canonical_locator') {
    exactKeys(evidence, ['kind', 'locator', 'sha256'], `context block '${block.id}' canonical evidence`);
    nonEmpty(evidence.locator, `context block '${block.id}' locator`);
    sha256(evidence.sha256, `context block '${block.id}' evidence sha256`);
    return;
  }
  if (evidence.kind === 'observational_query') {
    exactKeys(evidence, ['kind', 'tool', 'arguments', 'observed_sha256'], `context block '${block.id}' observational evidence`);
    nonEmpty(evidence.tool, `context block '${block.id}' observational tool`);
    sha256(evidence.observed_sha256, `context block '${block.id}' observed_sha256`);
    canonicalJson(evidence.arguments);
    return;
  }
  throw new Error(`Context block '${block.id}' has invalid evidence kind.`);
}

function validateCanonicalSourceIdentity(identity: CanonicalSourceIdentity): void {
  if (identity.kind === 'conversation_message') {
    exactKeys(identity, ['kind', 'sessionId', 'messageId'], 'canonical message source identity');
    nonEmpty(identity.sessionId, 'canonical source sessionId');
    nonEmpty(identity.messageId, 'canonical source messageId');
    return;
  }
  if (identity.kind === 'tool_exchange') {
    exactKeys(identity, ['kind', 'sessionId', 'sourceInputId', 'toolCallId'], 'canonical tool source identity');
    nonEmpty(identity.sessionId, 'canonical source sessionId');
    nonEmpty(identity.sourceInputId, 'canonical source sourceInputId');
    nonEmpty(identity.toolCallId, 'canonical source toolCallId');
    return;
  }
  throw new Error('Canonical source identity has invalid kind.');
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error(`${label} must contain exactly ${wanted.join(', ')}; received ${actual.join(', ')}.`);
}

function nonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
}

function sha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
}
