import { describe, expect, it } from '@jest/globals';

import {
  isRuntimeStoppedInterruption,
  RuntimeStoppedInterruption,
} from '../../../src/runtime/actors/runtime-stopped-interruption.js';

describe('isRuntimeStoppedInterruption', () => {
  it('classifies only actual RuntimeStoppedInterruption instances', () => {
    expect(isRuntimeStoppedInterruption(new RuntimeStoppedInterruption())).toBe(true);
    expect(isRuntimeStoppedInterruption(new Error('Runtime project execution stopped.'))).toBe(false);
    expect(isRuntimeStoppedInterruption({
      name: 'Error',
      message: 'Runtime project execution stopped.',
    })).toBe(false);
  });
});
