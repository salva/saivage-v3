import { describe, expect, it } from '@jest/globals';

import * as analystApi from '../../src/agents/analyst-api.js';
import * as configApi from '../../src/agents/config-api.js';
import * as toolApi from '../../src/agents/tool-api.js';

describe('agents module ownership boundary', () => {
  it('publishes explicit API modules for analyst, tool, and config consumers', () => {
    expect(configApi.saivageConfigSchema).toBeDefined();
    expect(analystApi.getAnalystHandler).toBeDefined();
    expect(analystApi.GLOBAL_ANALYST_SESSION_ID).toBe('analyst:global');
    expect(toolApi.evaluateAuthz).toBeDefined();
    expect(toolApi.ANALYST_TOOL_DEFINITIONS).toBeDefined();
  });
});
