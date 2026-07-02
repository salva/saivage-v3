import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import Button from '../../components/ui/Button.vue';
import Card from '../../components/ui/Card.vue';
import Overlay from '../../components/ui/Overlay.vue';


describe('ui primitives', () => {
  it('renders Button variants and disabled state on a native button', () => {
    const wrapper = mount(Button, { props: { variant: 'primary', disabled: true }, slots: { default: 'Save' } });
    expect(wrapper.element.tagName).toBe('BUTTON');
    expect(wrapper.classes()).toContain('ui-button--primary');
    expect(wrapper.attributes()).toHaveProperty('disabled');
    expect(wrapper.text()).toBe('Save');
  });

  it('renders Card with semantic classes', () => {
    expect(mount(Card, { slots: { default: 'Body' } }).classes()).toContain('ui-card');
  });

  it('renders Overlay visibility and slot content', async () => {
    const wrapper = mount(Overlay, { props: { visible: true }, slots: { default: '<div class="dialog">Dialog</div>' } });
    expect(wrapper.find('.ui-overlay').exists()).toBe(true);
    expect(wrapper.find('.dialog').text()).toBe('Dialog');

    await wrapper.setProps({ visible: false });
    expect(wrapper.find('.ui-overlay').exists()).toBe(false);
  });
});
