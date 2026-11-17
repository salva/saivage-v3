import { randomUUID } from 'node:crypto';
import type { CompiledProjectWorkflows } from '../../src/runtime/runtime-api.js';
import { cardAgentSessionId, agentMessageSchema } from '../../src/schemas/index.js';
import { appendConversationBatch, readCurrentConversationSegment, publishCompactedConversationSegment } from '../../src/persistence/conversation-file.js';
import { versionFilename } from '../../src/persistence/canonical-conversation-artifacts.js';
import { readCard } from '../../src/persistence/card-files.js';

/** Give synthetic GC candidates a real owning compaction boundary, not a bypass. */
export function compactWorkGcCard(root: string, workflows: CompiledProjectWorkflows, cardId = 'project',
  timestamp: string | ((agent: string) => string | null) = '2026-10-24T00:01:00.000Z'): void {
  const card = readCard(root, cardId);
  if (!card) throw new Error('Missing fixture card.');
  const workflow = workflows.cardTypes.get(card.type)!;
  const names = new Set([...workflow.states.values()].flatMap(state =>
    state.kind === 'node' && state.execution.kind === 'agent' && state.execution.agent.session === 'card'
      ? [state.execution.agent.name] : []));
  for (const agent of names) {
    const session = cardAgentSessionId(agent, cardId);
    if (readCurrentConversationSegment(root, session)) continue;
    const selectedTimestamp = typeof timestamp === 'string' ? timestamp : timestamp(agent);
    if (selectedTimestamp === null) continue;
    const row = agentMessageSchema.parse({ id: randomUUID(), session_id: session, role: 'user',
      kind: 'text', content: 'Synthetic GC boundary.',
      context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' },
        audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true },
      round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0,
      timestamp: '2026-10-24T00:00:00.000Z' });
    appendConversationBatch({ projectRoot: root }, [row]);
    const entryId = randomUUID();
    publishCompactedConversationSegment({ projectRoot: root }, session, {
      identity: { genesisId: randomUUID(), entryId, segmentVersion: 2,
        timestamp: selectedTimestamp,
        filename: versionFilename(2, entryId) },
      history: { summaryText: 'Synthetic GC boundary.', protectedPrompts: [],
        requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [] } },
      cutoffSourceIndex: 0, cutoffMessageId: row.id, continuation: { kind: 'between_rounds' },
    });
  }
}
