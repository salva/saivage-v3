import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import ApiTokenEntry from '../components/auth/ApiTokenEntry.vue';

vi.mock('../api/auth', () => ({
  getAuthToken: vi.fn(() => 'synthetic-token-value'),
  setAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
}));

function waitForTransition(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 250));
}

describe('ApiTokenEntry lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('emits close on Escape only while visible and cleans up its key listener', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const onClose = vi.fn();
    const wrapper = mount(ApiTokenEntry, {
      attachTo: document.body,
      props: { visible: true, onClose },
    });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ visible: false });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

    wrapper.unmount();
  });

  it('emits close from Cancel', async () => {
    const onClose = vi.fn();
    const wrapper = mount(ApiTokenEntry, {
      attachTo: document.body,
      props: { visible: true, onClose },
    });

    await wrapper.get('.token-btn-cancel').trigger('click');

    expect(onClose).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('emits close for overlay clicks but not dialog clicks', async () => {
    const onClose = vi.fn();
    const wrapper = mount(ApiTokenEntry, {
      attachTo: document.body,
      props: { visible: true, onClose },
    });

    await wrapper.get('.token-dialog').trigger('click');
    expect(onClose).not.toHaveBeenCalled();

    await wrapper.get('.token-overlay').trigger('click');
    expect(onClose).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('parent removes the overlay after close and underlying controls can be clicked', async () => {
    const ParentHarness = defineComponent({
      components: { ApiTokenEntry },
      setup() {
        const visible = ref(true);
        const underlyingClicks = ref(0);
        return { visible, underlyingClicks };
      },
      template: `
        <div>
          <button class="underlying-control" @click="underlyingClicks += 1">underlying</button>
          <ApiTokenEntry :visible="visible" @close="visible = false" />
        </div>
      `,
    });

    const wrapper = mount(ParentHarness, { attachTo: document.body });

    expect(wrapper.find('.token-overlay').exists()).toBe(true);
    await wrapper.get('.token-btn-cancel').trigger('click');
    await nextTick();
    await waitForTransition();

    expect(wrapper.find('.token-overlay').exists()).toBe(false);
    await wrapper.get('.underlying-control').trigger('click');
    expect(wrapper.vm.underlyingClicks).toBe(1);

    wrapper.unmount();
  });
});
