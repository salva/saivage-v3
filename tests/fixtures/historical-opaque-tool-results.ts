export const historicalOpaqueToolResults = [
  {
    toolName: 'list_agent_sessions',
    result: {
      success: true,
      data: [{ id: 'agent:planner:project', model: 'sk-historical', nested: { apiKey: 'historical-secret' } }],
    },
  },
  {
    toolName: 'read_agent_session',
    result: {
      success: true,
      data: {
        session: { id: 'agent:planner:project', status: 'inactive' },
        activity_status: { status: 'inactive', pending_calls: [] },
        total_messages: 1,
        returned: 1,
        parse_errors: 0,
        messages: [{ content: 'Authorization: Bearer historical-secret' }],
      },
    },
  },
  {
    toolName: 'emit_result',
    result: {
      success: false,
      error: 'token=historical-secret',
      data: { accepted: false, summary: 'token=historical-secret', legacy_payload: ['unchanged-shape'] },
    },
  },
] as const;
