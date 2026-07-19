import { describe, expect, it } from '@jest/globals';

import {
  executorActorId,
  parseLlmActorId,
  plannerActorId,
  reviewerActorId,
} from '../../../src/runtime/actors/ids.js';
import type { ConversationRole } from '../../../src/schemas/index.js';

describe('LLM actor exact conversation identities', () => {
  const cases: Array<[string, { role: ConversationRole; cardId: string | null }]> = [
    ['analyst:global', { role: 'analyst', cardId: null }],
    ['planner:project', { role: 'planner', cardId: 'project' }],
    ['reviewer:card-a', { role: 'reviewer', cardId: 'card-a' }],
    ['executor:card-a-b-c', { role: 'executor', cardId: 'card-a-b-c' }],
  ];

  it.each(cases)('parses %s', (id, expected) => {
    expect(parseLlmActorId(id)).toEqual(expected);
  });

  it('constructs canonical card conversation session ids', () => {
    expect(plannerActorId('project')).toBe('planner:project');
    expect(reviewerActorId('card-a')).toBe('reviewer:card-a');
    expect(executorActorId('card-a-b')).toBe('executor:card-a-b');
  });

  it.each([
    'global',
    'analyst:test',
    'planner:',
    'planner:card-A',
    'reviewer:card-a-b-c-d-e-f',
    'executor:project:extra',
  ])('rejects malformed session %s', (id) => {
    expect(() => parseLlmActorId(id)).toThrow();
  });
});
