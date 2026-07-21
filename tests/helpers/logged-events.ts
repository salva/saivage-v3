import type { LoggedEventByKind } from '../../src/schemas/index.js';

const timestamp = '2026-01-01T00:00:00.000Z';

export const representativeLoggedEvents = {
  runtime_diagnostic: { id: 'event-runtime-diagnostic', kind: 'runtime_diagnostic', timestamp, card_id: 'card-a', goal_id: 'project', phase: 'execute', error_message: 'boom' },
  runtime_actionable_error: { id: 'event-runtime-actionable', kind: 'runtime_actionable_error', timestamp, actionable_error: { message: 'fix this', code: 'TEST', nextAction: 'retry' } },
  mcp_tool_invocation: { id: 'event-mcp', kind: 'mcp_tool_invocation', timestamp, server: 'tools', tool: 'inspect', success: false, duration_ms: 12, error: 'tool failed' },
} as const satisfies { [K in keyof LoggedEventByKind]: LoggedEventByKind[K] };

export const allRepresentativeLoggedEvents = Object.values(representativeLoggedEvents);
