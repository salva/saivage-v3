import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendConversationBatch, initializeConversation, readConversation } from '../../../src/persistence/conversation-file.js';
import { providerConversationProjection } from '../../../src/runtime/actors/conversation-session.js';
import { CONTENT_POLICY_RETRY_TEXT, parseCanonicalContentPolicyRefusal } from '../../../src/schemas/index.js';
import { buildContentPolicyRefusalMessage, buildContentPolicyRetryMessage } from '../../../src/runtime/actors/content-policy-messages.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { currentConversationSegmentPath } from '../../helpers/current-conversation-segment-path.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('content-policy conversation rows', () => {
  it('builds strict fixed retry and exact canonical terminal evidence', () => {
    const sessionId = 'agent:executor:project' as const;
    const sourceInputId = '00000000-0000-4000-8000-000000000001';
    const retry = buildContentPolicyRetryMessage(sessionId, sourceInputId);
    expect(retry).toMatchObject({ role: 'user', kind: 'content_policy_retry', content: CONTENT_POLICY_RETRY_TEXT });
    expect(retry).not.toHaveProperty('tool');
    const marker = buildContentPolicyRefusalMessage({ sessionId, sourceInputId, candidate: { provider: 'test', account: null, model: 'model' }, providerResponse: 'terminal raw' });
    expect(parseCanonicalContentPolicyRefusal(marker.content)).toEqual({ version: 1, type: 'content_policy_refusal', source_input_id: sourceInputId, candidate: { provider: 'test', account: null, model: 'model' }, provider_response: 'terminal raw' });
    expect(marker).toMatchObject({ role: 'system', kind: 'content_policy_refusal' });
    expect(marker).not.toHaveProperty('tool');
  });

  it('appends the marker in one rows envelope and never projects physical evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'content-policy-conversation-')); roots.push(root); initProjectTree(root);
    const sessionId = 'agent:executor:project' as const;
    initializeConversation(root, sessionId);
    const sourceInputId = '00000000-0000-4000-8000-000000000001';
    const marker = buildContentPolicyRefusalMessage({ sessionId, sourceInputId, candidate: { provider: 'test', account: 'account', model: 'model' }, providerResponse: 'RAW-TERMINAL-EVIDENCE' });
    appendConversationBatch({ projectRoot: root }, [marker]);
    const envelope = JSON.parse(readFileSync(currentConversationSegmentPath(root, sessionId), 'utf8').trim());
    expect(envelope.type).toBe('conversation-segment');
    expect(envelope.rows.slice(1)).toEqual([marker]);
    const projected = providerConversationProjection(readConversation(root, sessionId), []);
    expect(projected.messages).toHaveLength(2);
    expect(projected.messages[0]).toMatchObject({ role: 'system', kind: 'synthetic_context', origin: 'context_boundary', block_identity: `${sessionId}:context-boundary` });
    expect(projected.messages[1]).toMatchObject({ role: 'user', kind: 'synthetic_context', origin: 'refusal_notice', block_identity: marker.id, content: expect.stringContaining(`/agents/${encodeURIComponent(sessionId)}?entry=${encodeURIComponent(marker.id)}`) });
    expect(JSON.stringify(projected)).not.toContain('RAW-TERMINAL-EVIDENCE');
  });
});
