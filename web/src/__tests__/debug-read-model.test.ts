import { describe, expect, it } from 'vitest';
import type { CardRecord, ContentReview, DebugTimelineEvent, DoctorCheck, DoctorIssue, ProcessView } from '../api/types';
import { filterTimelineByKinds, selectCardStatusEntries, selectDoctorIssuesBySeverity, selectErrorsBySource, selectFailedChecks, selectOperatorDataFreshnessLabel, selectReviewsByStatus, selectSortedProcesses, selectSortedTimeline, selectTimelineDerivedErrors } from '../stores/debug-read-model';

function process(overrides: Partial<ProcessView>): ProcessView {
  return {
    id: overrides.id ?? 'p',
    status: 'exited',
    started_at: '2025-01-01T00:00:00Z',
    ended_at: null,
    exit_code: null,
    timed_out: false,
    owner: 'agent',
    owner_id: null,
    session_id: null,
    card_id: 'card',
    command: 'echo ok',
    cwd: null,
    logs: { stdout: null, stderr: null, combined: null },
    ...overrides,
  };
}

describe('debug-read-model', () => {
  it('derives redacted errors from timeline events and groups them by source', () => {
    const events: DebugTimelineEvent[] = [{ kind: 'runtime_diagnostic', session_id: 'session-a', timestamp: '2025-01-01T00:00:00Z', error_message: 'token secret' }];
    const errors = selectTimelineDerivedErrors(events);

    expect(errors[0].source).toBe('session-a');
    expect(errors[0].severity).toBe('error');
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
      { kind: 'runtime_diagnostic', session_id: 's', timestamp: '2025-01-01T00:00:00Z', error_message: 'boom' },
      { kind: 'invocation_failed', session_id: 's', timestamp: '2025-01-01T00:00:01Z', error_message: 'legacy' } as DebugTimelineEvent,
    ];
    expect(selectSortedTimeline(events).map((e) => e.kind)).toEqual(['runtime_diagnostic']);
    expect(selectTimelineDerivedErrors(events).map((e) => e.type)).toEqual(['runtime_diagnostic']);
  });

  it('groups doctor and supervision projections without store-only computed state', () => {
    const checks: DoctorCheck[] = [
      { name: 'card-index-integrity', passed: false, details: '3 cards missing from index' },
      { name: 'file-metadata-count', passed: true },
      { name: 'orphan-detection', passed: false, details: '2 orphan files' },
    ];
    const issues: DoctorIssue[] = [
      { severity: 'error', message: 'Card #abc referenced by card #def but not found' },
      { severity: 'warning', message: 'Orphan file .saivage-work/quarantine/xyz.log' },
    ];
    const reviews: ContentReview[] = [
      { id: 'r1', source_kind: 'command_output', source_ref: 'proc-1/stdout', status: 'passed', summary: 'No sensitive data detected', risk: 'low', quarantine_id: null, created_at: '2025-06-01T10:00:00Z' },
      { id: 'r2', source_kind: 'file', source_ref: '.saivage-work/output/report.md', status: 'blocked', summary: 'Contains PII pattern', risk: 'high', quarantine_id: 'q-abc123', created_at: '2025-06-01T10:05:00Z' },
      { id: 'r3', source_kind: 'download', source_ref: 'https://example.com/data.csv', status: 'sanitized', summary: 'PII redacted', risk: 'medium', quarantine_id: null, created_at: '2025-06-01T10:10:00Z' },
    ];

    expect(selectFailedChecks(checks).map((check) => check.name)).toEqual(['card-index-integrity', 'orphan-detection']);
    expect(selectFailedChecks([{ name: 'ok', passed: true }])).toEqual([]);

    const issuesBySeverity = selectDoctorIssuesBySeverity(issues);
    expect(issuesBySeverity.get('error')).toHaveLength(1);
    expect(issuesBySeverity.get('warning')).toHaveLength(1);

    const reviewsByStatus = selectReviewsByStatus(reviews);
    expect(reviewsByStatus.get('passed')).toHaveLength(1);
    expect(reviewsByStatus.get('blocked')).toHaveLength(1);
    expect(reviewsByStatus.get('sanitized')).toHaveLength(1);
  });
});
