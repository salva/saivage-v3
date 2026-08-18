import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { AgentOperatorReadModelService } from '../../src/application/read-models/agent-operator-read-model.js';
import { appendConversationBatch, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { cardConversationVersionFile } from '../../src/persistence/layout.js';
import { initProjectTree, TEST_RUNTIME_WORKFLOWS } from '../helpers/canonical-project.js';

describe('conversation operation-specific read sets', () => {
  it('lists catalog metadata without opening the current segment', () => {
    const root = mkdtempSync(join(tmpdir(), 'conversation-read-set-')); initProjectTree(root);
    try {
      appendConversationBatch({ projectRoot: root }, [{ id: 'message', session_id: 'agent:planner:project', role: 'user', kind: 'text', content: 'message', context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } }, round_id: `r-user-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' }]);
      const segment = readCurrentConversationSegment(root, 'agent:planner:project')!;
      unlinkSync(cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename));
      const service = new AgentOperatorReadModelService(root, TEST_RUNTIME_WORKFLOWS, () => new Set());
      expect(service.listConversationVersions('agent:planner:project').versions).toHaveLength(1);
      expect(() => service.getConversation('agent:planner:project')).toThrow(/unavailable/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
