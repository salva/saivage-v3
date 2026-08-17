import { createHash } from 'node:crypto';

import { canonicalJson, type CanonicalContextPolicy, type SettledToolEvidence } from '../../src/schemas/index.js';
import { PRIMARY_TOOL_RESULT_POLICY_TEMPLATE, compileInvocationToolContract, type ToolResultPolicyTemplate } from '../../src/runtime/actors/llm-invocation.js';
import { durableContentPolicy, structuralContextPolicy } from '../../src/runtime/actors/context/index.js';

export { durableContentPolicy, structuralContextPolicy };

export function testToolCallPolicy(template: ToolResultPolicyTemplate = PRIMARY_TOOL_RESULT_POLICY_TEMPLATE): Extract<CanonicalContextPolicy, { kind: 'tool_call' }> {
  const compiled = compileInvocationToolContract({ type: 'function', function: { name: 'fixture', description: 'fixture', parameters: { type: 'object' } } }, template);
  return { kind: 'tool_call', template: compiled.resultPolicyTemplate, template_bytes: compiled.resultPolicyTemplateBytes, template_sha256: compiled.resultPolicyTemplateSha256 };
}

export function testToolResultPolicy(result: unknown, callPolicy = testToolCallPolicy(), settlementOrigin: Extract<CanonicalContextPolicy, { kind: 'tool_result' }>['settlement_origin'] = 'executed', evidence: SettledToolEvidence = { kind: 'none' }): Extract<CanonicalContextPolicy, { kind: 'tool_result' }> {
  const bytes = canonicalJson(result);
  return { kind: 'tool_result', settlement_origin: settlementOrigin, result_content_sha256: createHash('sha256').update(bytes, 'utf8').digest('hex'), call_policy_sha256: callPolicy.template_sha256, evidence };
}
