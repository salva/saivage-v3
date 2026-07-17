import { describe, expect, it } from 'vitest';

import { parseAgentDetailRouteParam } from '../router/agent-session-route';

describe('Agent detail route identity boundary', () => {
  it.each(['analyst:global', 'planner:project', 'reviewer:project', 'executor:project'])('accepts exact identity %s', (sessionId) => {
    expect(parseAgentDetailRouteParam(sessionId)).toEqual({ kind: 'valid', sessionId });
  });

  it.each(['', 'global', 'analyst:test', 'analyst:telegram-42', 'analyst:other', ['planner:project']])('rejects malformed route value %j', (value) => {
    expect(parseAgentDetailRouteParam(value)).toEqual({ kind: 'invalid' });
  });

  it('distinguishes the absent list-route parameter', () => {
    expect(parseAgentDetailRouteParam(undefined)).toEqual({ kind: 'none' });
  });
});
