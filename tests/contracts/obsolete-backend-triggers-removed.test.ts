import { describe, expect, it } from '@jest/globals';
import { ANALYST_TOOL_NAMES } from '../../src/agents/analyst-tool-schemas.js';
import { TOOL_REGISTRY } from '../../src/agents/analyst-llm-resolver.js';
import { operatorApiContracts } from '../../src/contracts/operator-api.js';
import { Runtime } from '../../src/runtime/runtime.js';

describe('obsolete backend trigger contracts are removed', () => {
  it('does not expose lets_dance analyst tool or registry entry', () => {
    expect(ANALYST_TOOL_NAMES).not.toContain('lets_dance');
    expect(Object.keys(TOOL_REGISTRY)).not.toContain('lets_dance');
  });

  it('does not expose card mutation contracts', () => {
    expect('cards.create' in operatorApiContracts).toBe(false);
    expect('cards.update' in operatorApiContracts).toBe(false);
  });

  it('runtime no longer exposes directive wakeup API', () => {
    expect('requestProjectDirectiveWakeup' in Runtime.prototype).toBe(false);
  });
});
