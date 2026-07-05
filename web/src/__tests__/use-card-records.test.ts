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

function jsonBody(content: unknown): { content: string } {
  return { content: JSON.stringify(content) };
}

describe('useCardRecords', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    getFileContent.mockReset();
  });

  it('loads the latest brief, status, and review records for a card', async () => {
    getFileContent.mockImplementation(async (path: string) => {
      if (path.endsWith('/brief/index.json')) return jsonBody({ slot: 'brief', latest: 3, open: null, versions: {} });
      if (path.endsWith('/brief/3.md')) return { content: '# Goal: ship the feature' };
      if (path.endsWith('/status/index.json')) return jsonBody({ slot: 'status', latest: 1, open: null, versions: {} });
      if (path.endsWith('/status/1.md')) return { content: 'Implementation in progress.' };
      if (path.endsWith('/review/index.json')) return jsonBody({ slot: 'review', latest: 2, open: null, versions: {} });
      if (path.endsWith('/review/2.md')) return { content: 'Accepted with evidence.' };
      throw new ApiError(404, 'not found', {});
    });

    const cardId = ref<string | null | undefined>('card-7');
    const { state } = useCardRecords(cardId);
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(state.value.brief.exists).toBe(true);
    expect(state.value.brief.version).toBe(3);
    expect(state.value.brief.content).toBe('# Goal: ship the feature');
    expect(state.value.status.exists).toBe(true);
    expect(state.value.status.content).toBe('Implementation in progress.');
    expect(state.value.review.exists).toBe(true);
    expect(state.value.review.content).toBe('Accepted with evidence.');
  });

  it('treats a missing slot index as a non-existent record rather than an error', async () => {
    getFileContent.mockRejectedValue(new ApiError(404, 'File not found', {}));

    const cardId = ref<string | null | undefined>('card-7');
    const { state } = useCardRecords(cardId);
    await flushPromises();
    await flushPromises();

    expect(state.value.brief.exists).toBe(false);
    expect(state.value.brief.content).toBeNull();
    expect(state.value.brief.error).toBeNull();
  });

  it('reloads records when the card id ref changes', async () => {
    getFileContent.mockRejectedValue(new ApiError(404, 'File not found', {}));

    const cardId = ref<string | null | undefined>('card-1');
    const { state } = useCardRecords(cardId);
    await flushPromises();
    await flushPromises();
    expect(getFileContent.mock.calls.length).toBeGreaterThan(0);
    const firstCount = getFileContent.mock.calls.length;

    cardId.value = 'card-2';
    await flushPromises();
    await flushPromises();
    expect(getFileContent.mock.calls.length).toBeGreaterThan(firstCount);
    expect(state.value.brief.exists).toBe(false);
  });
});
