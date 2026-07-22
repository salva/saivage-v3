import { describe, expect, it } from '@jest/globals';

import * as analystApi from '../../src/agents/analyst-api.js';
import * as configApi from '../../src/agents/config-api.js';

describe('agents module ownership boundary', () => {
  it('publishes explicit API modules for analyst and config consumers', () => {
    expect(configApi.saivageConfigSchema).toBeDefined();
    expect(analystApi.AnalystRuntime).toBeDefined();
    expect('resolveAnalystSessionId' in analystApi).toBe(false);
  });
});
