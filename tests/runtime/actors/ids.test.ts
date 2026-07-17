import { describe, expect, it } from '@jest/globals';

import { actorKindFromId, parseLlmActorId } from '../../../src/runtime/actors/ids.js';

describe('LLM actor exact conversation identities', () => {
  const cases: Array<[string, { role: string; cardId: string | null }]> = [
    ['analyst:global', { role: 'analyst', cardId: null }],
    ['planner:project', { role: 'planner', cardId: 'project' }],
    ['reviewer:project', { role: 'reviewer', cardId: 'project' }],
    ['executor:card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', { role: 'executor', cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
  ];
  it.each(cases)('classifies %s', (id, expected) => {
    expect(actorKindFromId(id)).toBe('llm');
    expect(parseLlmActorId(id)).toEqual(expected);
  });

  it.each(['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'])('rejects %s', (id) => {
    expect(() => actorKindFromId(id)).toThrow();
    expect(() => parseLlmActorId(id)).toThrow();
  });
});
