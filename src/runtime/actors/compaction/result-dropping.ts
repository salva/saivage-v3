import type { AgentMessage } from '../../../schemas/index.js';
import { canonicalJson } from '../../../schemas/index.js';
import { loggedToolCallIdentity, loggedToolCallKey, loggedToolResultIdentity } from '../../../schemas/message-identity.js';

declare const summarizerProviderRow: unique symbol;
export type SummarizerProviderRow = AgentMessage & { readonly [summarizerProviderRow]: true };

export type RecoverableEvidenceDescriptor =
  | { flavor: 'observational_query'; tool: string; args: unknown; observed_sha256: string; label: string }
  | { flavor: 'canonical_locator'; locator: string; sha256: string; label: string };

export function buildSummarizerProviderRows(messages: readonly AgentMessage[]): SummarizerProviderRow[] {
  const calls = toolCallsByCompositeIdentity(messages);
  return messages.map((message) => {
    if (message.kind !== 'tool_result' || message.context_policy.kind !== 'tool_result') return cloneMessage(message);
    const identity = loggedToolResultIdentity(message);
    const call = identity ? calls.get(loggedToolCallKey(identity)) : undefined;
    if (!call || call.context_policy.kind !== 'tool_call') throw new Error(`Tool result '${message.id}' has no exact call policy.`);
    if (call.context_policy.template.settledAudience !== 'evidence_only') return cloneMessage(message);
    return withContent(message, canonicalJson({ success: JSON.parse(message.content).success, evidence: message.context_policy.evidence }));
  });
}

export function recoverableEvidenceDescriptors(messages: readonly AgentMessage[]): RecoverableEvidenceDescriptor[] {
  const calls = toolCallsByCompositeIdentity(messages);
  const descriptors: RecoverableEvidenceDescriptor[] = [];
  for (const message of messages) {
    if (message.kind !== 'tool_result' || message.context_policy.kind !== 'tool_result') continue;
    const identity = loggedToolResultIdentity(message);
    const call = identity ? calls.get(loggedToolCallKey(identity)) : undefined;
    if (!call) throw new Error(`Tool result '${message.id}' has no exact composite-identity call.`);
    const evidence = message.context_policy.evidence;
    if (evidence.kind === 'observational_query') descriptors.push({ flavor: 'observational_query', tool: call.tool!, args: toolCallArgs(call), observed_sha256: evidence.observedSha256, label: call.tool! });
    if (evidence.kind === 'canonical_locator') descriptors.push({ flavor: 'canonical_locator', locator: evidence.locator, sha256: evidence.sha256, label: call.tool! });
  }
  return descriptors;
}

function toolCallsByCompositeIdentity(messages: readonly AgentMessage[]): Map<string, AgentMessage> {
  const calls = new Map<string, AgentMessage>();
  for (const message of messages) {
    const identity = loggedToolCallIdentity(message);
    if (!identity) continue;
    const key = loggedToolCallKey(identity);
    if (calls.has(key)) throw new Error(`Duplicate tool call composite identity '${key}'.`);
    calls.set(key, message);
  }
  return calls;
}

function toolCallArgs(message: AgentMessage): unknown {
  const content = JSON.parse(message.content) as { tool_calls?: Array<{ function?: { arguments?: string } }> };
  const value = content.tool_calls?.[0]?.function?.arguments;
  if (typeof value !== 'string') throw new Error(`Tool call '${message.id}' has malformed arguments.`);
  return JSON.parse(value) as unknown;
}

function withContent(message: AgentMessage, content: string): SummarizerProviderRow { return { ...message, content } as SummarizerProviderRow; }
function cloneMessage(message: AgentMessage): SummarizerProviderRow { return { ...message } as SummarizerProviderRow; }
