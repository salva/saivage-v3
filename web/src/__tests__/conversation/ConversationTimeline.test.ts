import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ConversationTimeline from '../../components/conversation/ConversationTimeline.vue';
import type { AgentTimeline } from '../../utils/agent-timeline';

function emptyTimeline(overrides: Partial<AgentTimeline> = {}): AgentTimeline {
  return { rounds: [], activeRoundId: null, modelLabel: null, ...overrides };
}

describe('ConversationTimeline', () => {
  it('renders the ambient model chip when the timeline carries a model label', () => {
    const wrapper = mount(ConversationTimeline, {
      props: { timeline: emptyTimeline({ modelLabel: 'claude-sonnet-4' }), expandedIds: new Set<string>() },
    });

    const chip = wrapper.find('[data-testid="timeline-model"]');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain('claude-sonnet-4');
  });

  it('omits the ambient model chip when no model label is present', () => {
    const wrapper = mount(ConversationTimeline, {
      props: { timeline: emptyTimeline({ modelLabel: null }), expandedIds: new Set<string>() },
    });

    expect(wrapper.find('[data-testid="timeline-model"]').exists()).toBe(false);
  });
});
