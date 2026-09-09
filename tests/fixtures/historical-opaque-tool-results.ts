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
  {
    toolName: 'webfetch',
    result: {
      success: true,
      data: { redacted_url: 'https://example.test/', text: 'token=historical-secret', bytes: 23, truncated: false },
    },
  },
  {
    toolName: 'glob',
    result: {
      success: true,
      data: { directory: '.', pattern: '**/*', matches: ['historical-a.txt', 'token=historical-secret'], truncated: true },
    },
  },
  {
    toolName: 'grep',
    result: {
      success: true,
      data: { pattern: 'needle', matches: [{ path: 'historical.txt', line: 1, preview: 'Authorization: Bearer historical-secret' }], truncated: false },
    },
  },
  {
    toolName: 'glob',
    result: {
      success: true,
      data: { matches: { total: 1, position: { item_index: 0, item_byte_offset: 0 }, returned: 1, next: null, items: [{ content: 'historical plaintext token=historical-secret', utf8_bytes: 44, offset_bytes: 0, next_offset_bytes: 44, total_bytes: 44 }] } },
    },
  },
  {
    toolName: 'grep',
    result: {
      success: true,
      data: { matches: { total: 1, position: { item_index: 0, item_byte_offset: 0 }, returned: 1, next: null, items: [{ content_hex: '2261736b2d7365637265742d7461696c22', utf8_bytes: 17, offset_bytes: 0, next_offset_bytes: 17, total_bytes: 17 }] }, content_truncated: false, max_line_chars: 2000 },
    },
  },
] as const;
