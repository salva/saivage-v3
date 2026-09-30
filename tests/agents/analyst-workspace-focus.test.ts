import { describe, expect, it } from '@jest/globals';
import { buildAnalystWorkspaceFocus, ANALYST_WORKSPACE_FOCUS_MAX_BYTES } from '../../src/application/read-models/analyst-workspace-focus.js';
import { ChatWorkspaceContextSchema, MAX_ANALYST_WORKSPACE_CONTEXT_BYTES } from '../../src/contracts/operator-api-chats.js';
import type { CardService } from '../../src/cards/store-api.js';

const cards = [{ id: 'card-a', type: 'goal', version_seq: 2, lifecycle: { status: 'backlog' }, title: '多\\"'.repeat(200), status_text: '🧭\\"'.repeat(400), status_text_updated_at: '2026-09-29T00:00:00.000Z' }] as unknown as ReturnType<CardService['list']>;
function payload(context: Parameters<typeof buildAnalystWorkspaceFocus>[0]): { route: { entityId: string | null }; focus: any } {
  const result = buildAnalystWorkspaceFocus(context, cards);
  expect(result.kind).toBe('rendered');
  if (result.kind !== 'rendered') throw new Error('Expected rendered focus');
  expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(ANALYST_WORKSPACE_FOCUS_MAX_BYTES);
  return JSON.parse(result.content);
}

describe('Analyst workspace focus', () => {
  it('matches an exact card or owning-card session, never inventing session execution state', () => {
    expect(payload({ view: 'cockpit', entityId: 'card-a', refinement: null }).focus).toMatchObject({ relation: 'card', card_id: 'card-a', version_seq: 2, card_status_text_preview: { truncated: true } });
    expect(payload({ view: 'cockpit', entityId: 'agent:executor:card-a', refinement: null }).focus).toMatchObject({ relation: 'owning_card', card_id: 'card-a' });
    expect(payload({ view: 'cockpit', entityId: 'agent:analyst:global', refinement: null }).focus).toBe('not_provided');
    expect(payload({ view: 'cockpit', entityId: 'card-b', refinement: null }).focus).toBe('unavailable');
    expect(payload({ view: 'files', entityId: 'card-a', refinement: null }).focus).toBe('not_provided');
    expect(payload(undefined).focus).toBe('no_focus');
  });

  it('keeps exact unredacted identities, sorts and escapes opaque metadata, and redacts before previewing', () => {
    const observation = payload({ view: 'cockpit', entityId: 'card-a', refinement: { z: '"\n', a: 'sk-a' } });
    expect(observation.route.entityId).toBe('card-a');
    expect(observation.focus.title.text).toContain('多');
    expect(observation.focus.title.truncated).toBe(true);
    expect(JSON.stringify(observation)).not.toContain('sk-a');
    expect(payload({ view: 'cockpit', entityId: 'sk-a', refinement: null }).focus).toBe('withheld');
  });

  it('admits the exact input byte boundary and returns a budget result on real redaction expansion', () => {
    const base = { view: 'files' as const, entityId: '', refinement: null };
    const overhead = Buffer.byteLength(JSON.stringify(base), 'utf8');
    const accepted = { ...base, entityId: 'x'.repeat(MAX_ANALYST_WORKSPACE_CONTEXT_BYTES - overhead) };
    expect(ChatWorkspaceContextSchema.safeParse(accepted).success).toBe(true);
    expect(ChatWorkspaceContextSchema.safeParse({ ...base, entityId: accepted.entityId + '🧭' }).success).toBe(false);
    const expansion = { view: 'files' as const, entityId: null, refinement: Object.fromEntries(Array.from({ length: 105 }, (_, index) => [`k${index}`, 'sk-a'])) };
    expect(ChatWorkspaceContextSchema.safeParse(expansion).success).toBe(true);
    expect(buildAnalystWorkspaceFocus(expansion, cards)).toEqual({ kind: 'budget_exceeded' });
  });

  it('rejects a required skeleton that cannot fit without slicing a valid exact card identity', () => {
    const longId = `card-${'a'.repeat(1900)}`;
    const route = { view: 'cockpit' as const, entityId: longId, refinement: null };
    expect(ChatWorkspaceContextSchema.safeParse(route).success).toBe(true);
    const longCard = [{ ...cards[0]!, id: longId }] as ReturnType<CardService['list']>;
    expect(buildAnalystWorkspaceFocus(route, longCard)).toEqual({ kind: 'budget_exceeded' });
  });
});
