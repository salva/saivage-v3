import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCardRunsResponse } from '../../src/application/read-models/runtime-card-runs-read-model.js';
import { CardService } from '../../src/cards/card-service.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import type { RuntimeState } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';

describe('runtime card-runs read model', () => {
  let projectRoot: string;
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('returns exact card-runs keys without cards_with_pending_corrections', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-card-runs-'));
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot);
    const project = store.read('project')!;
    appendConversationBatch({ projectRoot }, [{ id: 'planner-message', session_id: 'planner:project', role: 'user', kind: 'text', content: 'plan', round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-18T00:00:00.000Z' }]);
    appendConversationBatch({ projectRoot }, [{ id: 'reviewer-message', session_id: 'reviewer:project', role: 'user', kind: 'text', content: 'review', round_id: 'r-user-11111111111111111111111111111111', message_index: 0, block_index: 0, timestamp: '2026-07-18T00:00:00.000Z' }]);
    const state: RuntimeState = { status: 'running', project_id: 'project', pid: 4242, started_at: '2026-07-18T00:00:00.000Z', current_card_id: 'project', updated_at: '2026-07-18T00:00:01.000Z' };
    const response = buildCardRunsResponse(projectRoot, store, { getRuntimeState: () => state });
    expect(Object.keys(response)).toEqual(['current_card_id', 'active_breadcrumb', 'dormant_planners']);
    expect(response).toEqual({
      current_card_id: 'project',
      active_breadcrumb: [{ card_id: 'project', card_type: project.type, title: project.title }],
      dormant_planners: [{ goal_card_id: 'project', planner_session_id: 'planner:project', latest_self_report: null }],
    });
    expect(response).not.toHaveProperty('cards_with_pending_corrections');
  });
});
