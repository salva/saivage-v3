import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { useCardRecords } from '../composables/useCardRecords';

const getFileContent = vi.fn();
const ApiErrorCtor = vi.hoisted(function () {
  return class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
    get isUnauthorized() { return this.status === 401; }
    get isNotFound() { return this.status === 404; }
  };
});

vi.mock('../api/client', () => ({
  getFileContent: (...args: any[]) => getFileContent(...args),
  ApiError: ApiErrorCtor,
}));

import { ApiError } from '../api/client';

describe('useCardRecords', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    getFileContent.mockReset();
  });

  it('loads the latest brief, status, and review records for a card', async () => {
    getFileContent.mockImplementation(async (path: string) => {
      if (path.startsWith('record:///brief.md')) return { content: '# Goal: ship the feature', version: 3, modifiedAt: '2026-07-13T10:00:00.000Z' };
      if (path.startsWith('record:///status.md')) return { content: 'Implementation in progress.', version: 1, modifiedAt: '2026-07-13T10:01:00.000Z' };
      if (path.startsWith('record:///review.md')) return { content: 'Accepted with evidence.', version: 2, modifiedAt: '2026-07-13T10:02:00.000Z' };
      throw new ApiError(404, 'not found', {});
    });

    const cardId = ref<string | null | undefined>('11111111-1111-4111-8111-111111111111');
    const { state } = useCardRecords(cardId);
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(state.value.brief.exists).toBe(true);
    expect(state.value.brief.version).toBe(3);
    expect(state.value.brief.committedAt).toBe('2026-07-13T10:00:00.000Z');
    expect(state.value.brief.content).toBe('# Goal: ship the feature');
    expect(state.value.status.exists).toBe(true);
    expect(state.value.status.content).toBe('Implementation in progress.');
    expect(state.value.review.exists).toBe(true);
    expect(state.value.review.content).toBe('Accepted with evidence.');
  });

  it('treats a missing logical record as non-existent rather than an error', async () => {
    getFileContent.mockRejectedValue(new ApiError(404, 'File not found', {}));

    const cardId = ref<string | null | undefined>('11111111-1111-4111-8111-111111111111');
    const { state } = useCardRecords(cardId);
    await flushPromises();
    await flushPromises();

    expect(state.value.brief.exists).toBe(false);
    expect(state.value.brief.content).toBeNull();
    expect(state.value.brief.error).toBeNull();
  });

  it('reloads records when the card id ref changes', async () => {
    getFileContent.mockRejectedValue(new ApiError(404, 'File not found', {}));

    const cardId = ref<string | null | undefined>('11111111-1111-4111-8111-111111111111');
    const { state } = useCardRecords(cardId);
    await flushPromises();
    await flushPromises();
    expect(getFileContent.mock.calls.length).toBeGreaterThan(0);
    const firstCount = getFileContent.mock.calls.length;

    cardId.value = '22222222-2222-4222-8222-222222222222';
    await flushPromises();
    await flushPromises();
    expect(getFileContent.mock.calls.length).toBeGreaterThan(firstCount);
    expect(state.value.brief.exists).toBe(false);
  });
});
