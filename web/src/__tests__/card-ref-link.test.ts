import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import CardRefLink from '../components/cards/CardRefLink.vue';

describe('CardRefLink', () => {
  it('renders current friendly labels and emits stable ids', async () => {
    const wrapper = mount(CardRefLink, { props: { refView: { id: 'card-33', display_path: '1.2.1', title: 'Implement card refs' } } });

    expect(wrapper.text()).toContain('1.2.1');
    expect(wrapper.text()).toContain('Implement card refs');
    await wrapper.trigger('click');
    expect(wrapper.emitted('navigate')?.[0]).toEqual(['card-33']);
  });

  it('keeps raw ids primary in debug mode', () => {
    const wrapper = mount(CardRefLink, { props: { mode: 'debugRaw', refView: { id: 'card-33', display_path: '1.2.1', title: 'Implement card refs' } } });

    expect(wrapper.find('.card-ref-primary').text()).toBe('card-33');
    expect(wrapper.text()).toContain('1.2.1');
  });

  it('marks missing references explicitly', () => {
    const wrapper = mount(CardRefLink, { props: { refView: { id: 'card-404', display_path: null, title: null, missing: true } } });

    expect(wrapper.text()).toContain('card-404 (missing)');
  });
});
