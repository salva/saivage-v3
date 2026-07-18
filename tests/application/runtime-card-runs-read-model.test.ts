import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCardRunsResponse } from '../../src/application/read-models/runtime-card-runs-read-model.js';
import { CardService } from '../../src/cards/card-service.js';
import type { RuntimeState } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';

describe('runtime card-runs read model', () => {
  let projectRoot: string;
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('projects the exact current card ID and derives only this endpoint breadcrumb', () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-card-runs-'));
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot);
    const state: RuntimeState = { status: 'running', project_id: 'project', pid: 4242, started_at: '2026-07-18T00:00:00.000Z', current_card_id: 'project', updated_at: '2026-07-18T00:00:01.000Z' };
    expect(buildCardRunsResponse(projectRoot, store, { getRuntimeState: () => state })).toMatchObject({
      current_card_id: 'project',
      active_breadcrumb: [{ card_id: 'project' }],
    });
  });
});
