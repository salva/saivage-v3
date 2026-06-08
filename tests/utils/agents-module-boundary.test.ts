import { describe, expect, it } from '@jest/globals';

import * as analystApi from '../../src/agents/analyst-api.js';
import * as configApi from '../../src/agents/config-api.js';
import * as sessionApi from '../../src/agents/session-api.js';
import * as toolApi from '../../src/agents/tool-api.js';
import { loadConfig } from '../../src/agents/config-schema.js';

describe('agents module ownership boundary', () => {
  it('publishes explicit API modules for analyst, session, tool, and config consumers', () => {
    expect(configApi.loadConfig).toBe(loadConfig);
    expect(sessionApi.listSessions).toBeDefined();
    expect(sessionApi.readLatestLlmExchange).toBeDefined();
    expect(analystApi.getAnalystHandler).toBeDefined();
    expect(analystApi.GLOBAL_ANALYST_SESSION_ID).toBe('analyst');
    expect(toolApi.evaluateAuthz).toBeDefined();
    expect(toolApi.ANALYST_TOOL_DEFINITIONS).toBeDefined();
  });
});
