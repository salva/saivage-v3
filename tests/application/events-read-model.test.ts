import { describe, expect, it, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventsReadModelService } from '../../src/application/read-models/index.js';
import { EventLogger } from '../../src/observability/index.js';

const timestamp = '2026-01-01T00:00:00.000Z';

describe('EventsReadModelService', () => {
  const roots: string[] = [];

  function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'saivage-events-read-model-'));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function seed(projectRoot: string): void {
    const logger = new EventLogger(join(projectRoot, '.saivage'));
    logger.appendEvent({ kind: 'runtime_diagnostic', id: 'evt-runtime', timestamp, error_message: 'runtime' });
    logger.appendEvent({ kind: 'runtime_diagnostic', id: 'evt-session-1', timestamp, session_id: 'planner:goal-1', goal_id: 'goal-1', card_id: 'goal-1', error_message: 'planner' });
    logger.appendEvent({ kind: 'runtime_diagnostic', id: 'evt-session-2', timestamp, session_id: 'executor:card-1', goal_id: 'goal-1', card_id: 'card-1', error_message: 'executor' });
    logger.appendEvent({ kind: 'runtime_actionable_error', id: 'evt-actionable', timestamp, actionable_error: { code: 'test', message: 'test', nextAction: 'test' } });
  }

  it('preserves total-before-pagination and legacy limit/offset parsing', () => {
    const projectRoot = makeProjectRoot();
    seed(projectRoot);
    const readModel = new EventsReadModelService(projectRoot);

    const page = readModel.listEvents({ goal_id: 'goal-1', limit: '1.5', offset: '1.8' });

    expect(page.total).toBe(2);
    expect(page.events.map((event) => event.id)).toEqual(['evt-session-2']);
  });

  it('defaults invalid pagination and accepts unknown event kinds as zero matches', () => {
    const projectRoot = makeProjectRoot();
    seed(projectRoot);
    const readModel = new EventsReadModelService(projectRoot);

    expect(readModel.listEvents({ limit: '-1', offset: 'not-a-number' }).events).toHaveLength(4);
    expect(readModel.listEvents({ kind: 'future_unknown_kind' }).events).toEqual([]);
  });

  it('filters by session_id and clamps large limits to 500 without using EventLogger pagination', () => {
    const projectRoot = makeProjectRoot();
    seed(projectRoot);
    const readModel = new EventsReadModelService(projectRoot);

    const response = readModel.listEvents({ session_id: 'planner:goal-1', limit: '999' });

    expect(response.total).toBe(1);
    expect(response.events[0]?.id).toBe('evt-session-1');
  });
});
