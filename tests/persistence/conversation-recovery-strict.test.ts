import { afterEach, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { stabilizeAgentSession } from '../../src/runtime/actors/conversation-recovery.js';
import {
  appendConversationBatch,
  isConversationCatalogEstablished,
  readConversation,
  readCurrentConversationSegment,
} from '../../src/persistence/conversation-file.js';
import {
  cardConversationVersionFile,
  cardConversationVersionIndexFile,
} from '../../src/persistence/layout.js';
import { initializeAndValidateCurrentGeneratedState } from '../../src/persistence/current-generated-graph.js';
import { TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'strict-card-recovery-'));
  roots.push(root);
  initProjectTree(root);
  return root;
}
const session = 'agent:planner:project' as const;
function stabilize(root: string) {
  stabilizeAgentSession({
    sessionId: session,
    conversations: { projectRoot: root },
    terminalToolNames: new Set(['emit_result']),
  });
}
it('keeps valid empty required catalogs clean and lazy Oversight genuinely absent', () => {
  const root = fixture();
  const index = cardConversationVersionIndexFile(root, 'project', 'planner');
  const before = readFileSync(index);
  stabilize(root);
  expect(readConversation(root, session).physicalRows).toEqual([]);
  expect(readFileSync(index)).toEqual(before);
  expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).not.toThrow();
  expect(isConversationCatalogEstablished(root, 'agent:oversight:global')).toBe(false);
});
it('does not normalize a required absent card-session index into empty recovery', () => {
  const root = fixture();
  unlinkSync(cardConversationVersionIndexFile(root, 'project', 'planner'));
  expect(() => stabilize(root)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow(
    /Required conversation index.*saivage repair/,
  );
});
it('does not normalize a nested missing selected segment into empty recovery; strict boot names safe owner/procedure', () => {
  const root = fixture();
  appendConversationBatch({ projectRoot: root }, [
    {
      id: 'row',
      session_id: session,
      role: 'user',
      kind: 'text',
      content: 'not a recovery notice',
      timestamp: '2026-10-04T00:00:00.000Z',
      round_id: `r-user-${'0'.repeat(32)}`,
      message_index: 1,
      block_index: 0,
      context_policy: TEXT_ROW_POLICY,
    },
  ]);
  const segment = readCurrentConversationSegment(root, session)!;
  const index = cardConversationVersionIndexFile(root, 'project', 'planner');
  const before = readFileSync(index);
  unlinkSync(cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename));
  expect(() => stabilize(root)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  expect(readFileSync(index)).toEqual(before);
  expect(() => initializeAndValidateCurrentGeneratedState(root, TEST_WORKFLOWS)).toThrow(
    /Strict canonical missing state for current conversation 'agent:planner:project'.*fresh complete stopped-project backup/,
  );
  expect(readFileSync(index)).toEqual(before);
});
