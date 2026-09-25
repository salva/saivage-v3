import { describe, expect, it } from 'vitest';
import { livenessPhrase, positionGloss, resultOneLiner, scopeWord, compactUuid, RESULT_ONE_LINER_MAX } from '../utils/legibility';

describe('livenessPhrase', () => {
  it('maps exactly the two contract-enforced pairs', () => {
    expect(livenessPhrase('active', 'busy')).toBe('Active — working now');
    expect(livenessPhrase('inactive', 'idle')).toBe('Idle — no current work');
  });

  it('falls back to the exact backend words for unknown pairs', () => {
    expect(livenessPhrase('active', 'idle')).toBe('active · idle');
    expect(livenessPhrase('paused', 'waiting')).toBe('paused · waiting');
  });
});

describe('positionGloss', () => {
  const graph = { nodes: [{ node_id: 'execute', agent_name: 'executor' }, { node_id: 'review', agent_name: 'reviewer' }] };

  it('glosses node positions with the configured agent', () => {
    expect(positionGloss({ cardType: 'code', stateId: 'node:execute', kind: 'node', nodeId: 'execute', executionOrdinal: 3 } as never, graph))
      .toBe("executor's step in this workflow.");
  });

  it('glosses terminal positions without lifecycle meaning', () => {
    expect(positionGloss({ cardType: 'code', stateId: 'terminal:DONE', kind: 'terminal', terminal: 'DONE' } as never, graph))
      .toBe('Terminal positions are configured end states, not lifecycle status.');
  });

  it('never guesses without a graph or matching node', () => {
    expect(positionGloss({ kind: 'node', nodeId: 'execute' } as never, null)).toBeNull();
    expect(positionGloss({ kind: 'node', nodeId: 'unknown' } as never, graph)).toBeNull();
    expect(positionGloss({ kind: 'entry', stateId: 'draft' } as never, graph)).toBeNull();
  });
});

describe('resultOneLiner', () => {
  it('quotes the recorded summary verbatim', () => {
    expect(resultOneLiner({ summary: 'Implemented the LE seek boundary fix.' })).toBe('Implemented the LE seek boundary fix.');
  });

  it('truncates long summaries at the bound with an ellipsis', () => {
    const long = 'x'.repeat(RESULT_ONE_LINER_MAX + 10);
    const oneLiner = resultOneLiner({ summary: long });
    expect(oneLiner).toHaveLength(RESULT_ONE_LINER_MAX + 1);
    expect(oneLiner?.endsWith('…')).toBe(true);
  });

  it('returns null without a result and key-lists only future summary-less shapes', () => {
    expect(resultOneLiner(null)).toBeNull();
    expect(resultOneLiner({ summary: '   ', alpha: 1, beta: 2 })).toBe('alpha, beta');
    expect(resultOneLiner({ alpha: 1, beta: 2, gamma: 3, delta: 4 })).toBe('alpha, beta, gamma');
  });
});

describe('scopeWord and compactUuid', () => {
  it('maps known scopes and passes unknown values through', () => {
    expect(scopeWord('card')).toBe('Card session');
    expect(scopeWord('global')).toBe('Global session');
    expect(scopeWord('tenant')).toBe('tenant');
  });

  it('shortens UUID-class values and keeps short values whole', () => {
    expect(compactUuid('00000000-0000-4000-8000-000000000099')).toBe('00000000…');
    expect(compactUuid('card-a')).toBe('card-a');
    expect(compactUuid('card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
});
