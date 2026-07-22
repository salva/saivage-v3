import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventQueryService } from '../../src/application/event-query-service.js';
import { createEventLog } from '../../src/observability/event-logger.js';
import { appLogFile } from '../../src/persistence/layout.js';
import { AppLogPublicationError } from '../../src/persistence/app-log.js';
import { OUTBOUND_IDENTITY, OUTBOUND_RAW_MARKER } from '../helpers/outbound-identity-fixtures.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('logged event outbound projection', () => {
  it('projects every event and actionable currentState variant before persistence and again on read', () => {
    const root = project();
    const log = createEventLog(root);
    const timestamp = '2026-07-22T10:00:00.000Z';

    log.appendEvent({ id: 'tok_event', timestamp, kind: 'runtime_diagnostic', goal_id: 'card-token', phase: 'sk-phase', error_message: 'token=diagnostic-secret' });
    log.appendEvent({ id: 'sk-contract-event', timestamp, kind: 'runtime_actionable_error', actionable_error: {
      code: 'contract_response_violation', message: 'Bearer contract-message-secret', nextAction: 'token=contract-action-secret',
      acceptedValues: ['tok_accepted'], docsRef: 'sk-doc-ref', runId: 'tok_run', sessionId: 'sk-session',
      currentState: { operation: OUTBOUND_IDENTITY, statusCode: 500, failureCode: 'sk-failure' },
    } });
    log.appendEvent({ id: 'sk-enum-event', timestamp, kind: 'runtime_actionable_error', actionable_error: {
      code: 'invalid_enum_value', message: 'token=enum-message-secret', nextAction: 'token=enum-action-secret',
      currentState: { field: OUTBOUND_IDENTITY, value: { token: OUTBOUND_RAW_MARKER, identity: 'sk-opaque' } },
    } });
    log.appendEvent({ id: 'tok_mcp_event', timestamp, kind: 'mcp_tool_invocation', server: 'ghu_server', tool: 'rt_tool', success: false, duration_ms: 12, error: 'password=mcp-secret' });

    const events = new EventQueryService(root).queryEvents().events;
    expect(events[0]).toMatchObject({ id: 'tok_event', goal_id: 'card-token', phase: 'sk-phase', error_message: 'token=[REDACTED]' });
    expect(events[1]).toMatchObject({ actionable_error: {
      code: 'contract_response_violation', acceptedValues: ['tok_accepted'], docsRef: 'sk-doc-ref', runId: 'tok_run', sessionId: 'sk-session',
      currentState: { operation: OUTBOUND_IDENTITY, statusCode: 500, failureCode: 'sk-failure' },
      message: 'Bearer [REDACTED]', nextAction: 'token=[REDACTED]',
    } });
    expect(events[2]).toMatchObject({ actionable_error: {
      currentState: { field: OUTBOUND_IDENTITY, value: { token: '[REDACTED]', identity: 'sk-[REDACTED]' } },
    } });
    expect(events[3]).toMatchObject({ server: 'ghu_server', tool: 'rt_tool', error: 'password=[REDACTED]' });

    const bytes = readFileSync(appLogFile(root), 'utf8');
    expect(bytes).not.toContain(OUTBOUND_RAW_MARKER);
    for (const secret of ['diagnostic-secret', 'contract-message-secret', 'contract-action-secret', 'enum-message-secret', 'enum-action-secret', 'opaque-secret', 'mcp-secret']) {
      expect(bytes).not.toContain(secret);
    }
    for (const identity of [OUTBOUND_IDENTITY, 'sk-failure', 'ghu_server', 'rt_tool', 'sk-phase']) {
      expect(bytes).toContain(identity);
    }
  });

  it('fails publication for a present currentState owned by no current actionable-error branch', () => {
    const root = project();
    let thrown: unknown;
    try {
      createEventLog(root).appendEvent({
        id: 'event', timestamp: '2026-07-22T10:00:00.000Z', kind: 'runtime_actionable_error',
        actionable_error: { code: 'future_code', message: 'message', nextAction: 'next', currentState: { value: 'unknown' } },
      });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AppLogPublicationError);
    expect((thrown as AppLogPublicationError).publicationCause).toEqual(expect.objectContaining({ message: expect.stringMatching(/unclassified currentState/) }));
  });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-event-redaction-'));
  roots.push(root);
  return root;
}
