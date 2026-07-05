import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import EntityInspectorShell from '../components/layout/EntityInspectorShell.vue';

describe('EntityInspectorShell', () => {
  it('renders a shared master-detail shell with an empty detail placeholder', () => {
    const wrapper = mount(EntityInspectorShell, {
      props: {
        selected: false,
        listLabel: 'Entities',
        detailLabel: 'Entity detail',
        emptyTitle: 'Select an entity',
      },
      slots: { list: '<div class="list-slot">List</div>', detail: '<div>Detail</div>' },
    });

    expect(wrapper.find('.entity-inspector-shell__list').attributes('aria-label')).toBe('Entities');
    expect(wrapper.text()).toContain('List');
    expect(wrapper.text()).toContain('Select an entity');
    expect(wrapper.text()).not.toContain('Detail');
  });

  it('emits back from the shared mobile detail header', async () => {
    const wrapper = mount(EntityInspectorShell, {
      props: {
        selected: true,
        listLabel: 'Entities',
        detailLabel: 'Entity detail',
        emptyTitle: 'Select an entity',
        backLabel: 'Back to entities',
        detailTitle: 'entity-1',
      },
      slots: { list: '<div>List</div>', detail: '<div class="detail-slot">Detail</div>' },
    });

    expect(wrapper.text()).toContain('entity-1');
    await wrapper.find('.back-btn').trigger('click');
    expect(wrapper.emitted('back')).toHaveLength(1);
  });
});
