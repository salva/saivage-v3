import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/publication-outcome.js';
import { testApplicationFatalDelivery } from '../../helpers/test-application-fatal-port.js';
import { ACTIVITY_ROW_POLICY, toolCallRowPolicy } from '../../helpers/row-policy-fixtures.js';
import * as actualConversationFile from '../../../src/persistence/conversation-file.js';

const operations: string[] = [];
let failingKind: 'tool_result' | 'model_recovered' | null = null;
let uncertainty: PublicationOutcomeUnknownError;
jest.unstable_mockModule('../../../src/persistence/conversation-file.js', () => ({
  ...actualConversationFile,
  readConversation: (...args: Parameters<typeof actualConversationFile.readConversation>) => {
    operations.push('read-conversation');
    return actualConversationFile.readConversation(...args);
  },
  appendConversationBatch: (...args: Parameters<typeof actualConversationFile.appendConversationBatch>) => {
    operations.push(`append:${args[1][0]?.kind}`);
    if (args[1][0]?.kind === failingKind) {
      // Model a committed notice whose publication outcome is still unknown to its owner.
      if (failingKind === 'model_recovered') actualConversationFile.appendConversationBatch(...args);
      throw uncertainty;
    }
    return actualConversationFile.appendConversationBatch(...args);
  },
}));
const { createSupervisorRuntimeApi } = await import('../../../src/runtime/actors/supervisor-runtime-api.js');
const { CardService, initProjectTree, TEST_RUNTIME_WORKFLOWS } = await import('../../helpers/canonical-project.js');

const roots: string[] = [];
afterEach(() => { failingKind = null; operations.length = 0; while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('startup session publication fatal boundary', () => {
  it.each(['tool_result', 'model_recovered'] as const)('passes the actual %s append uncertainty by identity to fatal and never continues', async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-session-fatal-')); roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    cards.setStatus('project', 'running'); cards.setStatus(child.id, 'running');
    const sessionId = `agent:executor:${child.id}` as const;
    const input = '11111111-1111-4111-8111-111111111111';
    const timestamp = '2026-08-10T00:00:00.000Z';
    actualConversationFile.appendConversationBatch({ projectRoot: root }, [{ id: `${input}:activation:executor`, session_id: sessionId,
      role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'executor', card_id: child.id, input_id: input, timestamp }),
      context_policy: ACTIVITY_ROW_POLICY, round_id: `r-pre-${'1'.repeat(32)}`, message_index: 0, block_index: 0, timestamp }]);
    actualConversationFile.appendConversationBatch({ projectRoot: root }, [{ id: `${input}:tool-call:pending`, session_id: sessionId,
      role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: 'pending', context_policy: toolCallRowPolicy(),
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'pending', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
      round_id: `r-assistant-${'1'.repeat(32)}`, message_index: 1, block_index: 0, timestamp }]);
    operations.length = 0;
    uncertainty = new PublicationOutcomeUnknownError();
    failingKind = kind;
    const read = cards.read.bind(cards);
    jest.spyOn(cards, 'read').mockImplementation((id) => { operations.push('read-card'); return read(id); });
    jest.spyOn(cards, 'stopRunning').mockImplementation(() => { operations.push('stop-card'); throw new Error('Unexpected stopped append.'); });
    const status = jest.fn(() => { operations.push('status'); });
    const fatal = jest.fn((error: PublicationOutcomeUnknownError): never => { operations.push('fatal'); expect(error).toBe(uncertainty); throw testApplicationFatalDelivery; });
    const runtime = createSupervisorRuntimeApi({ actorStore: cards, projectRoot: root, conversations: { projectRoot: root }, workflows: TEST_RUNTIME_WORKFLOWS,
      runtimeGate: new RuntimeGate(), fatalPort: { publicationOutcomeUnknown: fatal }, runtimeStatusChanged: status } as never);
    const cleanup = jest.spyOn(runtime, 'cleanupForApplicationStop');
    await expect(runtime.start()).rejects.toBe(testApplicationFatalDelivery);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal).toHaveBeenCalledWith(uncertainty);
    expect(operations.at(-1)).toBe('fatal');
    expect(operations.filter((event) => event.startsWith('append:'))).toEqual(kind === 'tool_result' ? ['append:tool_result'] : ['append:tool_result', 'append:model_recovered']);
    expect(status).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();

    // Only a different process may freshly consume this canonical committed prefix.
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'recovery-fresh-process.ts');
    const fresh = spawnSync(process.execPath, ['--import', 'tsx', fixture, root, 'startup-only'], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
    expect(fresh.status).toBe(0);
    const result = JSON.parse(fresh.stdout) as { cards: Array<{ id: string; status: string }>; status: { status: string } };
    expect(result.status.status).toBe('stopped');
    expect(result.cards).toEqual(expect.arrayContaining([{ id: 'project', status: 'stopped' }, { id: child.id, status: 'stopped' }]));
    const rows = actualConversationFile.readConversation(root, sessionId).physicalRows;
    expect(rows.filter((row) => row.kind === 'tool_result')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'model_recovered')).toHaveLength(1);
  });
});
