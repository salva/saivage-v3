import { describe, expect, it } from '@jest/globals';

import { historicalUnavailableStatus } from '../../src/application/read-models/historical-unavailable-status.js';

describe('historicalUnavailableStatus', () => {
  it.each<['missing' | 'corrupt' | 'io_error', 404 | 409 | 503]>([
    ['missing', 404],
    ['corrupt', 409],
    ['io_error', 503],
  ])('maps %s to %i', (reason, status) => {
    expect(historicalUnavailableStatus(reason)).toBe(status);
  });
});
