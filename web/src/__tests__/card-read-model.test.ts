import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { useCardBrowserReadModel } from '../composables/useCardBrowserReadModel';
import { useCardStore } from '../stores/cards';

describe('card browser read model', () => {
  it('discovers only an undiscovered expansion and collapse requests nothing', async () => {
    setActivePinia(createPinia());
    const store = useCardStore();
    const ensure = vi.spyOn(store, 'ensureChildren').mockResolvedValue();
    const model = useCardBrowserReadModel(store, () => null);
    await model.toggleTreeNode('card-a');
    expect(ensure).toHaveBeenCalledWith('card-a');
    await model.toggleTreeNode('card-a');
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});
