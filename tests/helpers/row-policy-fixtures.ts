import { createHash } from 'node:crypto';

import {
  canonicalJson,
  DURABLE_PRIMARY_CONTENT_POLICY,
  STRUCTURAL_ROW_POLICY,
  type RowContextPolicy,
  type SettledToolEvidence,
  type ToolResultPolicyTemplate,
  type ToolSettlementOrigin,
} from '../../src/schemas/index.js';
import { UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';

export const TEXT_ROW_POLICY = DURABLE_PRIMARY_CONTENT_POLICY;
export const ACTIVITY_ROW_POLICY = STRUCTURAL_ROW_POLICY.activation_boundary;

export function toolCallRowPolicy(template: ToolResultPolicyTemplate = UNSUPPORTED_TOOL_RESULT_POLICY_TEMPLATE): RowContextPolicy {
  const template_bytes = canonicalJson(template);
  return { kind: 'tool_call', template, template_bytes, template_sha256: createHash('sha256').update(template_bytes, 'utf8').digest('hex') };
}

export function toolResultRowPolicy(args: { content: string; callPolicySha256: string; settlementOrigin?: ToolSettlementOrigin; evidence?: SettledToolEvidence }): RowContextPolicy {
  return {
    kind: 'tool_result',
    settlement_origin: args.settlementOrigin ?? 'executed',
    result_content_sha256: createHash('sha256').update(args.content, 'utf8').digest('hex'),
    call_policy_sha256: args.callPolicySha256,
    evidence: args.evidence ?? { kind: 'none' },
  };
}

export function toolRowPolicies(args: { content: string; template?: ToolResultPolicyTemplate; settlementOrigin?: ToolSettlementOrigin; evidence?: SettledToolEvidence }): { call: RowContextPolicy; result: RowContextPolicy } {
  const call = toolCallRowPolicy(args.template);
  const result = toolResultRowPolicy({ content: args.content, callPolicySha256: call.kind === 'tool_call' ? call.template_sha256 : '', settlementOrigin: args.settlementOrigin, evidence: args.evidence });
  return { call, result };
}
