import { describe, expect, it, jest } from '@jest/globals';

import { DefaultAnalystCardMutationService } from '../../src/application/analyst-mutation-services.js';
import type { CardService } from '../../src/cards/card-api.js';
import type { CardRecord } from '../../src/schemas/index.js';

const FIRST = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND = 'card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('analyst card mutation service deletion', () => {
  it('delegates the complete requested root set to one atomic service preflight and returns deterministic deletion data', () => {
    const deleteSubtrees = jest.fn((ids: readonly string[], context: unknown, allowed: (card: CardRecord) => boolean) => {
      expect(ids).toEqual([FIRST, SECOND, FIRST]);
      expect(context).toEqual({ actor: 'analyst', surface: 'runtime', reason: 'analyst subtree deletion' });
      expect(allowed({ status: 'backlog' } as CardRecord)).toBe(true);
      expect(allowed({ status: 'running' } as CardRecord)).toBe(false);
      return { requested: [FIRST, SECOND], deleted: [SECOND, FIRST] };
    });
    const service = new DefaultAnalystCardMutationService({ deleteSubtrees } as unknown as CardService, 'web-chat');

    expect(service.delete([FIRST, SECOND, FIRST])).toEqual({
      success: true,
      data: { deleted: [SECOND, FIRST], top_level_deleted: [FIRST, SECOND] },
    });
    expect(deleteSubtrees).toHaveBeenCalledTimes(1);
  });

  it('returns one failure without a partial-success payload when complete preflight rejects', () => {
    const deleteSubtrees = jest.fn(() => { throw new Error(`Card '${SECOND}' cannot be deleted`); });
    const service = new DefaultAnalystCardMutationService({ deleteSubtrees } as unknown as CardService, 'web-chat');

    expect(service.delete([FIRST, SECOND])).toEqual({ success: false, error: `Card '${SECOND}' cannot be deleted` });
    expect(deleteSubtrees).toHaveBeenCalledTimes(1);
  });
});
