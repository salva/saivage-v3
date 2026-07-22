import { describe, expect, it } from '@jest/globals';

import * as analystApi from '../../src/agents/analyst-api.js';

describe('agents module ownership boundary', () => {
  it('publishes an explicit API module for analyst consumers', () => {
    expect(analystApi.AnalystRuntime).toBeDefined();
    expect('resolveAnalystSessionId' in analystApi).toBe(false);
  });
});
