import { initProjectTree } from '../helpers/canonical-project.js';
import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentOperatorReadModelService } from '../../src/application/read-models/agent-operator-read-model.js';
import { appendConversationMessage } from '../../src/runtime/actors/conversation-store.js';

describe('agent operator read model privacy', () => {
  it('omits OpenAI Responses private rows and visible marker internals from conversation API entries', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-agent-privacy-'));
    try {
      initProjectTree(projectRoot);
      const timestamp = '2026-01-01T00:00:00.000Z';
      appendConversationMessage(projectRoot, { id: 'input-1:provider-private:openai-responses', session_id: 'planner:project', role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', source_input_id: 'input-1', projection_message_id: 'input-1:message', provider: 'openai', model: 'gpt-5.6', output: [{ type: 'reasoning', encrypted_content: 'opaque-secret-reasoning' }] }), round_id: 'r-assistant-00000000000000000000000000000001', message_index: 1, block_index: 0, timestamp });
      appendConversationMessage(projectRoot, { id: 'input-1:message', session_id: 'planner:project', role: 'assistant', kind: 'text', content: 'visible', round_id: 'r-assistant-00000000000000000000000000000001', message_index: 1, block_index: 1, timestamp, provider_projection: { kind: 'openai_responses', source_input_id: 'input-1', private_message_id: 'input-1:provider-private:openai-responses', projection_kind: 'assistant_message' } });

      const result = new AgentOperatorReadModelService(projectRoot).getConversation('planner:project');

      expect(result.statusCode).toBeUndefined();
      expect(JSON.stringify(result.body)).not.toContain('opaque-secret-reasoning');
      expect(JSON.stringify(result.body)).not.toContain('provider_private');
      expect(JSON.stringify(result.body)).not.toContain('private_message_id');
      expect((result.body as { entries: unknown[] }).entries).toEqual([expect.objectContaining({ id: 'input-1:message', content: 'visible' })]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
