import type { AgentMessage, ContextAudience, ContextEvidence, ContextReplacement, SettledToolEvidence, ToolResultPolicyTemplate } from '../../../schemas/index.js';
import { parseToolCallMessageForModel } from '../../../contracts/persisted-tool-call.js';

function assertNever(value: never): never {
  throw new Error(`Unhandled exhaustive conversation row kind '${String(value)}'.`);
}

type StructuralRowProjection =
  | Readonly<{ behavior: 'activation_boundary'; primaryVisible: false; summaryEligible: false; note: 'opens rounds and is omitted from primary/summarizer prose' }>
  | Readonly<{ behavior: 'provider_failure'; primaryVisible: false; summaryEligible: false; note: 'following model-facing recovery text owns semantics' }>
  | Readonly<{ behavior: 'model_recovery_notice'; primaryVisible: true; summaryEligible: true; rendering: 'synthetic_system_notice'; note: 'model-facing recovery notice, never evidence-only' }>
  | Readonly<{ behavior: 'content_policy_refusal'; primaryVisible: true; summaryEligible: true; rendering: 'synthetic_refusal_text'; note: 'raw provider response is never replayed' }>
  | Readonly<{ behavior: 'responses_private'; primaryVisible: false; summaryEligible: false; rendering: 'paired_with_marked_visible_mate'; note: 'selectable only with its one marked visible mate' }>;

type ContentRowProjection = Readonly<{
  audience: ContextAudience;
  primaryVisible: true;
  summaryEligible: true;
  rendering: 'direct' | 'code_owned_retry_text';
}>;

type ToolExchangeRowProjection = Readonly<{
  primaryVisible: true;
  summaryEligible: true;
  bundle: 'call_template_only' | 'settled_pair';
  note: 'uncovered bundle remains primary-visible; an unmatched call is never coverable';
}>;

type ConversationRowPolicy =
  | Readonly<{ kind: 'content'; row: AgentMessage; projection: ContentRowProjection }>
  | Readonly<{ kind: 'structural'; row: AgentMessage; projection: StructuralRowProjection }>
  | Readonly<{ kind: 'tool_exchange'; row: AgentMessage; projection: ToolExchangeRowProjection }>;

export function classifyConversationRowPolicy(message: AgentMessage): ConversationRowPolicy {
  switch (message.kind) {
    case 'text':
      return { kind: 'content', row: message, projection: { audience: audienceOf(message), primaryVisible: true, summaryEligible: true, rendering: 'direct' } };
    case 'model_repair':
      return { kind: 'content', row: message, projection: { audience: audienceOf(message), primaryVisible: true, summaryEligible: true, rendering: 'direct' } };
    case 'content_policy_retry':
      return { kind: 'content', row: message, projection: { audience: audienceOf(message), primaryVisible: true, summaryEligible: true, rendering: 'code_owned_retry_text' } };
    case 'activity':
      return { kind: 'structural', row: message, projection: { behavior: 'activation_boundary', primaryVisible: false, summaryEligible: false, note: 'opens rounds and is omitted from primary/summarizer prose' } };
    case 'model_issue':
      return { kind: 'structural', row: message, projection: { behavior: 'provider_failure', primaryVisible: false, summaryEligible: false, note: 'following model-facing recovery text owns semantics' } };
    case 'model_recovered':
      return { kind: 'structural', row: message, projection: { behavior: 'model_recovery_notice', primaryVisible: true, summaryEligible: true, rendering: 'synthetic_system_notice', note: 'model-facing recovery notice, never evidence-only' } };
    case 'content_policy_refusal':
      return { kind: 'structural', row: message, projection: { behavior: 'content_policy_refusal', primaryVisible: true, summaryEligible: true, rendering: 'synthetic_refusal_text', note: 'raw provider response is never replayed' } };
    case 'provider_private':
      return { kind: 'structural', row: message, projection: { behavior: 'responses_private', primaryVisible: false, summaryEligible: false, rendering: 'paired_with_marked_visible_mate', note: 'selectable only with its one marked visible mate' } };
    case 'tool_call':
      return { kind: 'tool_exchange', row: message, projection: { primaryVisible: true, summaryEligible: true, bundle: 'call_template_only', note: 'uncovered bundle remains primary-visible; an unmatched call is never coverable' } };
    case 'tool_result':
      return { kind: 'tool_exchange', row: message, projection: { primaryVisible: true, summaryEligible: true, bundle: 'settled_pair', note: 'uncovered bundle remains primary-visible; an unmatched call is never coverable' } };
    default:
      return assertNever(message.kind);
  }
}

function audienceOf(message: AgentMessage): ContextAudience {
  if (message.context_policy.kind !== 'content') throw new Error(`Conversation row '${message.id}' of kind '${message.kind}' is missing its content policy.`);
  return message.context_policy.audience;
}

export type SettledToolBundlePolicy = Readonly<{
  storage: 'durable';
  replacement: Readonly<{ kind: 'retain' } | { kind: 'latest_snapshot'; key: string; contentSha256: string }>;
  settledAudience: ContextAudience;
  evidence: ContextEvidence;
}>;

export function settledToolBundlePolicy(call: AgentMessage, result: AgentMessage): SettledToolBundlePolicy {
  if (call.kind !== 'tool_call' || call.context_policy.kind !== 'tool_call') throw new Error(`Tool call '${call.id}' is missing its tool_call context policy.`);
  if (result.kind !== 'tool_result' || result.context_policy.kind !== 'tool_result') throw new Error(`Tool result '${result.id}' is missing its tool_result context policy.`);
  if (result.tool !== call.tool) throw new Error(`Tool result '${result.id}' does not name its call's tool.`);
  if (result.context_policy.call_policy_sha256 !== call.context_policy.template_sha256) throw new Error(`Tool result '${result.id}' does not commit to its call's policy template hash.`);
  const template: ToolResultPolicyTemplate = call.context_policy.template;
  const replacement: ContextReplacement = template.replacement.kind === 'retain'
    ? { kind: 'retain' }
    : { kind: 'latest_snapshot', key: template.replacement.key, contentSha256: result.context_policy.result_content_sha256 };
  const settled = result.context_policy.evidence;
  const evidence: ContextEvidence = resultSettledSuccessfully(result)
    ? deriveSuccessfulBundleEvidence(template, settled, result, call)
    : { kind: 'none' };
  return Object.freeze({ storage: 'durable', replacement, settledAudience: template.settledAudience, evidence });
}

function deriveSuccessfulBundleEvidence(template: ToolResultPolicyTemplate, settled: SettledToolEvidence, result: AgentMessage, call: AgentMessage): ContextEvidence {
  switch (template.evidenceMode) {
    case 'none':
      return { kind: 'none' };
    case 'observational_query':
      if (settled.kind !== 'observational_query') throw new Error(`Tool result '${result.id}' requires observational settled evidence.`);
      return { kind: 'observational_query', tool: call.tool!, arguments: toolCallRowArguments(call), observed_sha256: settled.observedSha256 };
    case 'canonical_locator':
      if (settled.kind !== 'canonical_locator') throw new Error(`Tool result '${result.id}' requires canonical-locator settled evidence.`);
      return { kind: 'canonical_locator', locator: settled.locator, sha256: settled.sha256 };
  }
}

function resultSettledSuccessfully(result: AgentMessage): boolean {
  return (JSON.parse(result.content) as { success?: unknown }).success === true;
}

function toolCallRowArguments(call: AgentMessage): unknown {
  if (call.kind !== 'tool_call') throw new Error(`Row '${call.id}' is not a tool call.`);
  const embedded = parseToolCallMessageForModel(JSON.parse(call.content));
  try {
    return JSON.parse(embedded.arguments) as unknown;
  } catch {
    throw new Error(`Tool call '${call.id}' has malformed JSON arguments.`);
  }
}
