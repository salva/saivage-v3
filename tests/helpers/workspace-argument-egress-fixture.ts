import { readWorkspaceInputSchema } from '../../src/contracts/index.js';
import { agentMessageSchema, type ConversationSessionId } from '../../src/schemas/index.js';
import { toolRowPolicies } from './row-policy-fixtures.js';

export const WORKSPACE_ARGUMENT_CANARY = 'SYNTHETIC_PATH_CANARY';
export const WORKSPACE_ARGUMENT_PATH = `https://example.invalid/report?access_token=${WORKSPACE_ARGUMENT_CANARY} FINAL-PATH-Z`;
export const WORKSPACE_ARGUMENT_PUBLIC_PATH = 'https://example.invalid/report?access_token=[REDACTED] FINAL-PATH-Z';
export const WORKSPACE_ARGUMENT_SOURCE = '22222222-2222-4222-8222-222222222222';

/** Strict current-format synthetic calls; no executor or external access. */
export function workspaceArgumentEgressRows(session: ConversationSessionId, unmatched: boolean) {
  const args = readWorkspaceInputSchema.parse({ path: WORKSPACE_ARGUMENT_PATH, metadata_only: true });
  const content = JSON.stringify({ success: false, error: 'Synthetic rejected location FINAL-RESULT-Z' });
  const policy = toolRowPolicies({ content });
  const base = { session_id: session, round_id: `r-assistant-${WORKSPACE_ARGUMENT_SOURCE.replaceAll('-', '')}`, block_index: 0, timestamp: '2026-10-14T12:00:00.000Z', tool: 'read', tool_call_id: 'workspace-location' };
  const call = agentMessageSchema.parse({ ...base, id: `${WORKSPACE_ARGUMENT_SOURCE}:tool-call:workspace-location`, role: 'assistant', kind: 'tool_call', message_index: 0, context_policy: policy.call,
    content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: base.tool_call_id, type: 'function', function: { name: 'read', arguments: JSON.stringify(args) } }] }) });
  if (unmatched) return [call];
  return [call, agentMessageSchema.parse({ ...base, id: `${WORKSPACE_ARGUMENT_SOURCE}:tool-result:workspace-location`, role: 'tool', kind: 'tool_result', message_index: 1, context_policy: policy.result, content })];
}
