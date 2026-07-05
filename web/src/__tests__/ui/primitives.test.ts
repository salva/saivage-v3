import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import Button from '../../components/ui/Button.vue';
import Dialog from '../../components/ui/Dialog.vue';
import Panel from '../../components/ui/Panel.vue';
import SelectableRow from '../../components/ui/SelectableRow.vue';
import StatusBadge from '../../components/ui/StatusBadge.vue';
import StatusBanner from '../../components/ui/StatusBanner.vue';
import ViewState from '../../components/ui/ViewState.vue';


describe('ui primitives', () => {
  it('renders Button variants and disabled state on a native button', () => {
    const wrapper = mount(Button, { props: { variant: 'primary', disabled: true }, slots: { default: 'Save' } });
    expect(wrapper.element.tagName).toBe('BUTTON');
    expect(wrapper.classes()).toContain('ui-button--primary');
    expect(wrapper.attributes()).toHaveProperty('disabled');
    expect(wrapper.text()).toBe('Save');
  });

  it('renders Panel with semantic classes', () => {
    expect(mount(Panel, { slots: { default: 'Body' } }).classes()).toContain('ui-panel');
  });

  it('renders StatusBadge with accessible text and label', () => {
    const wrapper = mount(StatusBadge, { props: { status: { label: 'running', tone: 'active', description: 'Running now' }, showDot: true } });
    expect(wrapper.text()).toContain('running');
    expect(wrapper.attributes('aria-label')).toBe('running status');
    expect(wrapper.attributes('title')).toBe('Running now');
    expect(wrapper.find('.status-badge__dot').exists()).toBe(true);
  });

  it('uses alert role for dangerous StatusBanner tones', () => {
    const wrapper = mount(StatusBanner, { props: { tone: 'danger', title: 'Failed', message: 'Could not load' } });
    expect(wrapper.attributes('role')).toBe('alert');
    expect(wrapper.text()).toContain('Could not load');
  });

  it('renders ViewState with action slot and status role', () => {
    const wrapper = mount(ViewState, { props: { state: 'empty', title: 'No records' }, slots: { action: '<button>Retry</button>' } });
    expect(wrapper.attributes('role')).toBe('status');
    expect(wrapper.text()).toContain('No records');
    expect(wrapper.find('button').text()).toBe('Retry');
  });

  it('emits SelectableRow select from click and keyboard activation', async () => {
    const wrapper = mount(SelectableRow, { props: { as: 'div' }, slots: { default: 'Row' } });
    await wrapper.trigger('click');
    await wrapper.trigger('keydown', { key: 'Enter' });
    await wrapper.trigger('keydown', { key: ' ' });
    expect(wrapper.emitted('select')).toHaveLength(3);
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
