import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import { writeProject } from '../../src/tools/project-file-tools.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('project-file Analyst brief writes', () => {
  it('accepts blocked and reopens it to changed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-project-file-brief-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create({ type: 'code', parent: 'project', title: 'Blocked', brief: '# Goal\nOld\n# Instructions\nOld\n# Acceptance Criteria\nOld', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.setStatus(card.id, 'running');
    cards.commitActivationOutcome(card.id, { status: 'blocked', summary: 'wait', result: { kind: 'blocked', summary: 'wait', resume_reason: 'test' } }, '2026-07-17T00:00:00.000Z');

    await expect(writeProject({ projectRoot: root, cardId: card.id, agentRole: 'analyst', store: cards, notifyCard: () => ({ ok: true, notificationId: 'n' }) }, {
      path: `record:///brief.md?card=${card.id}&v=next`,
      content: '# Goal\nNew\n# Instructions\nNew\n# Acceptance Criteria\nNew',
    })).resolves.toMatchObject({ written: true, propagation: { ok: true } });
    expect(cards.read(card.id)?.lifecycle.status).toBe('changed');
  });

  it('rejects changed before opening a new brief version', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-project-file-brief-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create({ type: 'code', parent: 'project', title: 'Changed', brief: '# Goal\nOld\n# Instructions\nOld\n# Acceptance Criteria\nOld', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.setStatus(card.id, 'running');
    cards.commitActivationOutcome(card.id, { status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } }, '2026-07-22T00:00:00.000Z');
    cards.setStatus(card.id, 'changed');

    await expect(writeProject({ projectRoot: root, cardId: card.id, agentRole: 'analyst', store: cards, notifyCard: () => ({ ok: true, notificationId: 'n' }) }, {
      path: `record:///brief.md?card=${card.id}&v=next`,
      content: '# Goal\nNew\n# Instructions\nNew\n# Acceptance Criteria\nNew',
    })).rejects.toThrow('do not support target card status changed');
  });

  it('propagates strict open-record read failures instead of treating them as writable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-project-file-brief-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create({ type: 'code', parent: 'project', title: 'Strict', brief: '# Goal\nOld\n# Instructions\nOld\n# Acceptance Criteria\nOld', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const hostile = new Error('HOSTILE_STRICT_READ');
    const original = cards.readRecord.bind(cards);
    cards.readRecord = ((cardId, filename, version, instrumentation) => version === 'open' ? (() => { throw hostile; })() : original(cardId, filename, version, instrumentation)) as CardService['readRecord'];
    await expect(writeProject({ projectRoot: root, cardId: card.id, agentRole: 'analyst', store: cards, notifyCard: () => ({ ok: true, notificationId: 'n' }) }, { path: `record:///brief.md?card=${card.id}&v=next`, content: '# Goal\nNew\n# Instructions\nNew\n# Acceptance Criteria\nNew' })).rejects.toBe(hostile);
  });
});
