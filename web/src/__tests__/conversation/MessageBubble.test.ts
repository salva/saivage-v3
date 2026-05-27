import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageBubble from '../../components/conversation/MessageBubble.vue';

describe('MessageBubble', () => {
  it('renders slotted message text with role and metadata', () => {
    const wrapper = mount(MessageBubble, { props: { role: 'user', author: 'Operator', timestamp: '12:00' }, slots: { default: 'Hello Saivage' } });
    expect(wrapper.attributes('data-role')).toBe('user');
    expect(wrapper.classes()).toContain('message-bubble--user');
    expect(wrapper.text()).toContain('Operator');
    expect(wrapper.text()).toContain('Hello Saivage');
  });
});
