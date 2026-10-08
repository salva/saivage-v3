import { describe, expect, it } from 'vitest';
import { entriesToTimeline } from './timeline';
import { call, result, entry } from '../../__tests__/tool-presenters/fixtures';

describe('call-position visual timeline', () => {
  it('combines a cross-round result without changing source evidence or other message order', () => {
    const c = call('read', { path: 'README.md' });
    const correction = entry('correction', 'text', 'Actually inspect only this file', { message_index: -1 });
    const r = result('read', {}, { round_id: 'r-user-0000000000000000000000000000000b', timestamp: '2026-10-07T00:00:09Z' });
    const input = [c, correction, r];
    const before = JSON.stringify(input);
    const rows = entriesToTimeline(input).rounds.flatMap((round) => round.rows);
    expect(rows.map((row) => row.entry)).toEqual([c, correction]);
    expect(rows[0].mate).toBe(r);
    expect(rows[0].interveningEntries).toBe(1);
    expect(rows[0].mate!.round_id).toBe(r.round_id);
    expect(rows[0].mate!.timestamp).toBe(r.timestamp);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('does not collect a noncontiguous round into an earlier author run', () => {
    const a = entry('a', 'text', 'first');
    const b = entry('b', 'text', 'second', { round_id: 'r-user-0000000000000000000000000000000b' });
    const c = entry('c', 'text', 'third');
    const rounds = entriesToTimeline([a, b, c]).rounds;
    expect(rounds.map((r) => r.entries.map((e) => e.id))).toEqual([['a'], ['b'], ['c']]);
    expect(new Set(rounds.map((r) => r.id)).size).toBe(3);
  });
  it('keeps every individual observation and unmatched result visible without synthetic calls', () => {
    const a = call('read', { path: 'one' });
    const b = call('read', { path: 'two' }, 'other-call');
    const r = result('read', {}, { tool_call_id: 'not-retained' });
    const rows = entriesToTimeline([a, b, r]).rounds.flatMap((round) => round.rows);
    expect(rows.map((row) => row.entry.id)).toEqual(['call', 'other-call', 'result']);
    expect(rows.every((row) => row.mate === null)).toBe(true);
  });
  it('associates only retained selected-segment evidence', () => {
    const c = call('read');
    const r = result('read', {});
    expect(entriesToTimeline([c]).rounds[0].rows[0].mate).toBeNull();
    expect(entriesToTimeline([r]).rounds[0].rows[0].mate).toBeNull();
    expect(entriesToTimeline([c, r]).rounds[0].rows[0].mate).toBe(r);
  });
  it('ignores blank text and routine activity but retains diagnostic positions', () => {
    const a = entry('a', 'model_issue', 'Provider error');
    const b = entry('b', 'model_recovered', 'Recovered');
    const rows = entriesToTimeline([entry('blank', 'text', ' '), a, entry('activity', 'activity', '{"event":"llm_turn_started"}'), b]).rounds.flatMap((r) => r.rows);
    expect(rows.map((r) => r.entry)).toEqual([a, b]);
  });
  it('retains compacted context as a distinct run', () => {
    const compacted = entry('context', 'text', 'Retained summary', { round_id: 'r-compacted-0000000000000000000000000000000c' });
    const timeline = entriesToTimeline([compacted, call('read')]);
    expect(timeline.rounds.map((r) => r.kind)).toEqual(['compacted', 'assistant']);
  });
  it('updates an unmatched call in place, pairs interleaved calls, and omits result-only rounds', () => {
    const a = call('read', { path: 'one' });
    const b = call('read', { path: 'two' }, 'other-call');
    const ar = result('read', {}, { round_id: 'r-user-0000000000000000000000000000000b' });
    const br = result('read', {}, { id: 'other-result', tool_call_id: 'read:other-call', round_id: ar.round_id });
    const prose = entry('prose', 'text', 'Interleaved observation');
    const first = entriesToTimeline([a, b, prose]);
    const next = entriesToTimeline([a, b, prose, br, ar]);
    expect(next.rounds.map(round => round.id)).toEqual(first.rounds.map(round => round.id));
    expect(next.rounds.flatMap(round => round.rows).map(row => [row.entry.id, row.mate?.id])).toEqual([['call', 'result'], ['other-call', 'other-result'], ['prose', undefined]]);
  });
});
