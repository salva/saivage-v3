import { describe, it, expect } from '@jest/globals';
import { SessionStampCounter } from '../../src/runtime/session-stamp-counter.js';
import { roundIdGrammar } from '../../src/schemas/round-id.js';

describe('SessionStampCounter — collision-free round_id', () => {
  it('emits a unique 32-hex round_id for each stampUserMessage call within one session', () => {
    const counter = new SessionStampCounter();
    const a = counter.stampUserMessage('s');
    const b = counter.stampUserMessage('s');
    expect(a.round_id).not.toBe(b.round_id);
    expect(a.round_id).toMatch(roundIdGrammar);
    expect(b.round_id).toMatch(roundIdGrammar);
    expect(a.round_id).toMatch(/^r-user-[0-9a-f]{32}$/);
  });

  it('emits unique round_ids across different sessions', () => {
    const counter = new SessionStampCounter();
    const a = counter.stampUserMessage('session-a');
    const b = counter.stampUserMessage('session-b');
    expect(a.round_id).not.toBe(b.round_id);
  });

  it('reuses currentRoundId across stampInRound calls but mints a new one after closeRound', () => {
    const counter = new SessionStampCounter();
    counter.openAssistantRound('s');
    const a = counter.stampInRound('s');
    const b = counter.stampInRound('s');
    expect(a.round_id).toBe(b.round_id);
    counter.closeRound('s');
    counter.openAssistantRound('s');
    const c = counter.stampInRound('s');
    expect(c.round_id).not.toBe(a.round_id);
  });

  it('emits unique stampPre / stampCompacted ids', () => {
    const counter = new SessionStampCounter();
    const p1 = counter.stampPre('s');
    const p2 = counter.stampPre('s');
    const c1 = counter.stampCompacted('s');
    const c2 = counter.stampCompacted('s');
    expect(new Set([p1.round_id, p2.round_id, c1.round_id, c2.round_id]).size).toBe(4);
    expect(p1.round_id).toMatch(/^r-pre-[0-9a-f]{32}$/);
    expect(c1.round_id).toMatch(/^r-compacted-[0-9a-f]{32}$/);
  });
});
