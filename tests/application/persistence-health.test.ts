import { describe, expect, it } from '@jest/globals';

import { ApplicationPersistenceHealth, PersistenceMutationUnhealthyError } from '../../src/application/persistence-health.js';

describe('ApplicationPersistenceHealth', () => {
  it('records the first uncertain failure permanently and rejects later mutation', () => {
    const health = new ApplicationPersistenceHealth();
    expect(health.snapshot()).toEqual({ state: 'healthy' });

    expect(() => health.reportUncertainFailure({ target: 'state.json', operation: 'replace state', error: new Error('fsync failed') })).toThrow(PersistenceMutationUnhealthyError);
    const first = health.snapshot();
    expect(first).toMatchObject({ state: 'mutation_unhealthy', diagnostic: { target: 'state.json', operation: 'replace state', message: 'fsync failed' } });

    expect(() => health.reportUncertainFailure({ target: 'other.json', operation: 'replace other', error: new Error('later') })).toThrow(PersistenceMutationUnhealthyError);
    expect(health.snapshot()).toEqual(first);
    expect(() => health.assertMutationHealthy()).toThrow(PersistenceMutationUnhealthyError);
  });
});
