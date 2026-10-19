import { describe, expect, it } from '@jest/globals';
import { operatorApiContracts } from '../../src/contracts/operator-api.js';

describe('obsolete backend trigger contracts are removed', () => {
  it('does not register cards.create, cards.update, or cards.delete in the operator contract registry', () => {
    const contractIds = Object.keys(operatorApiContracts);
    expect(contractIds).not.toContain('cards.create');
    expect(contractIds).not.toContain('cards.update');
    expect(contractIds).not.toContain('cards.delete');
  });
});
