import { describe, expect, it } from 'vitest';

import { parseAgentDetailRouteParam } from '../router/agent-session-route';

describe('Agent detail route identity boundary', () => {
  it.each(['agent:analyst:global', 'agent:planner:project', 'agent:reviewer:project', 'agent:executor:project'])('accepts exact identity %s', (sessionId) => {
    expect(parseAgentDetailRouteParam(sessionId)).toEqual({ kind: 'valid', sessionId });
  });

  it.each(['', 'global', 'analyst:test', 'agent:analyst:telegram-42', 'agent:analyst:other', ['agent:planner:project']])('rejects malformed route value %j', (value) => {
    expect(parseAgentDetailRouteParam(value)).toEqual({ kind: 'invalid' });
  });

  it('distinguishes the absent list-route parameter', () => {
    expect(parseAgentDetailRouteParam(undefined)).toEqual({ kind: 'none' });
  });
});
