import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANALYST_TOOL_NAMES } from '../../src/tools/definitions/index.js';
import { TOOL_REGISTRY } from '../../src/agents/analyst-prompt.js';
import { operatorApiContracts } from '../../src/contracts/operator-api.js';

describe('obsolete backend trigger contracts are removed', () => {
  it('does not expose lets_dance analyst tool or registry entry', () => {
    expect(ANALYST_TOOL_NAMES).not.toContain('lets_dance');
    expect(Object.keys(TOOL_REGISTRY)).not.toContain('lets_dance');
  });

  it('does not register cards.create, cards.update, or cards.delete in the operator contract registry', () => {
    const contractIds = Object.keys(operatorApiContracts);
    expect(contractIds).not.toContain('cards.create');
    expect(contractIds).not.toContain('cards.update');
    expect(contractIds).not.toContain('cards.delete');
  });

  it('runtime no longer exposes directive wakeup API', () => {
    const source = readFileSync(join(process.cwd(), 'src/runtime/runtime.ts'), 'utf8');
    expect(source).not.toContain('requestProjectDirectiveWakeup');
  });
});
