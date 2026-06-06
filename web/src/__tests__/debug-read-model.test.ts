import { describe, expect, it } from 'vitest';
import type { CardRecord, DebugTimelineEvent, ProcessView } from '../api/types';
import { filterTimelineByKinds, selectCardStatusEntries, selectErrorsBySource, selectOperatorDataFreshnessLabel, selectSortedProcesses, selectSortedTimeline, selectTimelineDerivedErrors } from '../stores/debug-read-model';

function process(overrides: Partial<ProcessView>): ProcessView {
  return {
    id: overrides.id ?? 'p',
    status: 'exited',
    started_at: '2025-01-01T00:00:00Z',
    ended_at: null,
    exit_code: null,
    timed_out: false,
    owner: 'agent',
    session_id: null,
    card_id: 'card',
    command: 'echo ok',
    cwd: null,
    logs: { stdout: null, stderr: null, combined: null },
    control: { can_view_logs: false, termination_available: false, unavailable_reason: 'ended' },
    ...overrides,
  };
}

describe('debug-read-model', () => {
  it('derives redacted errors from timeline events and groups them by source', () => {
    const events: DebugTimelineEvent[] = [{ kind: 'card_failed', session_id: 'session-a', timestamp: '2025-01-01T00:00:00Z', error_message: 'token secret' }];
    const errors = selectTimelineDerivedErrors(events);

    expect(errors[0].source).toBe('session-a');
    expect(errors[0].severity).toBe('warning');
    expect([...selectErrorsBySource(errors).keys()]).toEqual(['session-a']);
  });

  it('projects status bars, timeline filters, freshness, and process ordering', () => {
    expect(selectCardStatusEntries([{ status: 'done' }, { status: 'done' }, { status: 'blocked' } as Partial<CardRecord> as CardRecord])).toEqual([
      { status: 'done', count: 2 },
      { status: 'blocked', count: 1 },
    ]);
    expect(filterTimelineByKinds([{ kind: 'a', timestamp: '1' }, { kind: 'b', timestamp: '2' }], ['b']).map((event) => event.kind)).toEqual(['b']);
    expect(selectOperatorDataFreshnessLabel('2025-01-01T00:00:00Z', new Date('2025-01-01T00:00:30Z').getTime())).toBe('fresh');
    expect(selectSortedProcesses([process({ id: 'old', status: 'exited' }), process({ id: 'run', status: 'running' })]).map((entry) => entry.id)).toEqual(['run', 'old']);
  });

  it('drops deprecated event kinds from both timeline and derived errors', () => {
    const events: DebugTimelineEvent[] = [
      { kind: 'card_failed', session_id: 's', timestamp: '2025-01-01T00:00:00Z', error_message: 'boom' },
      { kind: 'invocation_failed', session_id: 's', timestamp: '2025-01-01T00:00:01Z', error_message: 'legacy' } as DebugTimelineEvent,
    ];
    expect(selectSortedTimeline(events).map((e) => e.kind)).toEqual(['card_failed']);
    expect(selectTimelineDerivedErrors(events).map((e) => e.type)).toEqual(['card_failed']);
  });
});
