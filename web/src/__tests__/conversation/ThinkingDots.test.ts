import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ThinkingDots from '../../components/conversation/ThinkingDots.vue';

describe('ThinkingDots', () => {
  it('exposes a status label and three animated dots', () => {
    const wrapper = mount(ThinkingDots, { props: { label: 'Agent thinking' } });
    expect(wrapper.attributes('role')).toBe('status');
    expect(wrapper.attributes('aria-label')).toBe('Agent thinking');
    expect(wrapper.findAll('.thinking-dots__dot')).toHaveLength(3);
  });
});
