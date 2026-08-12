import { describe, expect, it } from '@jest/globals';
import { deterministicRoundId } from '../../src/schemas/round-id-server.js';

describe('deterministicRoundId', () => {
  it('derives exact durable round identities for every deterministic kind', () => {
    expect(deterministicRoundId('pre', 'input-123')).toBe(
      'r-pre-6b7bc1ccd7c748681d869e041900fbd2',
    );
    expect(deterministicRoundId('user', '11111111-1111-4111-8111-111111111111')).toBe(
      'r-user-bd7662a5eeb41614e720d477abfcb227',
    );
    expect(deterministicRoundId('assistant', 'provider-seed')).toBe(
      'r-assistant-f00c0ac65521259f34682a9a844accc7',
    );
  });
});
