import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import Button from '../../components/ui/Button.vue';
import Card from '../../components/ui/Card.vue';
import Dialog from '../../components/ui/Dialog.vue';


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

  it('renders Dialog visibility and slot content', async () => {
    const wrapper = mount(Dialog, { props: { visible: true, titleId: 'dialog-title' }, slots: { default: '<h2 id="dialog-title" class="dialog">Dialog</h2>' }, attachTo: document.body });
    expect(document.body.querySelector('.ui-dialog-overlay')).not.toBeNull();
    expect(document.body.querySelector('.dialog')?.textContent).toBe('Dialog');

    await wrapper.setProps({ visible: false });
    expect(document.body.querySelector('.ui-dialog-overlay')).toBeNull();
    wrapper.unmount();
  });
});
