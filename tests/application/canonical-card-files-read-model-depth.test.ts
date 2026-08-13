import { describe, expect, it, jest } from '@jest/globals';

import { CanonicalCardFilesReadModel, type CanonicalCardFilesReader } from '../../src/application/read-models/canonical-card-files-read-model.js';
import { MAX_CARD_DEPTH } from '../../src/schemas/card-id.js';

function cardPath(depth: number): string {
  return `.saivage/cards/project${'/children/a'.repeat(depth)}`;
}

describe('CanonicalCardFilesReadModel card depth', () => {
  it('delegates a depth-twelve path and rejects a thirteenth without a reader call', () => {
    const getCanonicalCardFilesMetadata = jest.fn(() => ({ kind: 'card-not-found' as const }));
    const reader = {
      getCanonicalCardFilesMetadata,
    } as unknown as CanonicalCardFilesReader;
    const model = new CanonicalCardFilesReadModel(() => reader);
    const twelve = `card-${Array.from({ length: MAX_CARD_DEPTH }, () => 'a').join('-')}`;

    expect(model.list(cardPath(MAX_CARD_DEPTH))).toEqual({ statusCode: 404, body: { error: 'Path not found', path: cardPath(MAX_CARD_DEPTH) } });
    expect(getCanonicalCardFilesMetadata).toHaveBeenCalledWith(twelve);
    getCanonicalCardFilesMetadata.mockClear();
    expect(model.list(cardPath(MAX_CARD_DEPTH + 1))).toEqual({ statusCode: 404, body: { error: 'Path not found', path: cardPath(MAX_CARD_DEPTH + 1) } });
    expect(getCanonicalCardFilesMetadata).not.toHaveBeenCalled();
  });
});
