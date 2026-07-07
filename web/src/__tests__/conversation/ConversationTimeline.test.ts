import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ConversationTimeline from '../../components/conversation/ConversationTimeline.vue';
import type { AgentTimeline, TimelineRound } from '../../utils/agent-timeline';

function emptyTimeline(overrides: Partial<AgentTimeline> = {}): AgentTimeline {
  return { rounds: [], activeRoundId: null, modelLabel: null, ...overrides };
}

function round(id: string, kind: TimelineRound['kind']): TimelineRound {
  return {
    id, kind, position: 1, entries: [], texts: [], diagnostics: [], toolPairs: [], items: [], activityStatus: null,
  };
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

  it('hides separator, agent name, and iteration number on consecutive same-author rounds', () => {
    const timeline = emptyTimeline({
      rounds: [
        round('r-assistant-1', 'assistant'),
        round('r-assistant-2', 'assistant'),
        round('r-user-1', 'user'),
      ],
    });

    const wrapper = mount(ConversationTimeline, { props: { timeline, expandedIds: new Set<string>() } });
    const cards = wrapper.findAll('[data-testid="round-card"]');

    expect(cards[0].classes()).not.toContain('continues-author');
    expect(cards[0].find('.round-head').exists()).toBe(true);

    expect(cards[1].classes()).toContain('continues-author');
    expect(cards[1].find('.round-head').exists()).toBe(false);

    expect(cards[2].classes()).not.toContain('continues-author');
    expect(cards[2].find('.round-head').exists()).toBe(true);
  });
});
