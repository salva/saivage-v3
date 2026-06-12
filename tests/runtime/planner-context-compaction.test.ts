import { describe, expect, it } from '@jest/globals';
import { buildXStatePlannerInput } from '../../src/runtime/actors/index.js';
import type { RuntimeContextCardReader } from '../../src/runtime/context-builder.js';
import type { CardRecord } from '../../src/schemas/types.js';

describe('planner prompt context compaction', () => {
  it('summarizes child evidence and long self-report fields instead of embedding artifact-heavy bodies in full', () => {
    const longBlob = 'artifact-body-'.repeat(1000);
    const cards = new Map<string, CardRecord>();
    cards.set('project', card({
      id: 'project',
      type: 'project',
      parent: null,
      latest_self_report: {
        summary: longBlob,
        details: { nested: longBlob },
      },
    }));
    cards.set('child-heavy', card({
      id: 'child-heavy',
      type: 'code',
      parent: 'project',
      depth: 1,
      title: 'Heavy child',
      description: 'child with bulky evidence',
      status: 'done',
      artifacts: Array.from({ length: 12 }, (_, index) => ({ id: `artifact-${index}`, card_id: 'child-heavy', type: 'report', description: `${index}:${longBlob}`, path: `.saivage-work/artifacts/${index}.txt`, retain: true, created_at: '2026-06-01T00:00:00.000Z' })),
      attachments: Array.from({ length: 12 }, (_, index) => ({ id: `attachment-${index}`, card_id: 'child-heavy', mime: 'text/plain', title: `${index}:${longBlob}`, path: `.saivage-work/attachments/${index}.txt`, created_at: '2026-06-01T00:00:00.000Z' })),
      lifecycle: { status: 'done', result: { kind: 'executor_success', executor: { status: 'completed', summary: longBlob, checklist_results: Array.from({ length: 20 }, (_, index) => ({ item: `item-${index}`, note: longBlob })) }, generated_files: [], verified_at: '2026-06-01T00:00:00.000Z', latest_self_report: { result: 'done', outcome: 'done', summary: longBlob, status_text: 'done', at: '2026-06-01T00:00:00.000Z' }, warnings: [] }, error: null, completed_at: '2026-06-01T00:00:00.000Z' },
    }));
    const reader: RuntimeContextCardReader = {
      read: (cardId) => cards.get(cardId) ?? null,
      listChildren: (cardId) => [...cards.values()].filter((item) => item.parent === cardId).map((item) => item.id),
      blocksFor: () => [],
    };

    const input = buildXStatePlannerInput({
      inputId: 'planner-input:project',
      card: { id: 'project', type: 'project' },
      context: { cards: reader },
    });

    expect(input.role).toBe('planner');
    expect(input.sessionId).toBe('planner:project');
    expect(input.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'activate_card' }) })]));
    expect(input.systemPrompt.length).toBeLessThan(30000);
    expect(input.systemPrompt).toContain('result_summary');
    expect(input.systemPrompt).toContain('omitted_count');
    expect(input.systemPrompt).toContain('[truncated');
    expect(input.systemPrompt).not.toContain(longBlob);
  });
});

function card(overrides: Partial<CardRecord>): CardRecord {
  return {
    id: 'card',
    type: 'goal',
    parent: 'project',
    depth: 0,
    title: 'Card',
    description: '',
    status: 'backlog',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    depends_on: [],
    related: [],
    artifacts: [],
    attachments: [],
    acceptance: '',
    retries: 0,
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    ...overrides,
  } as CardRecord;
}
