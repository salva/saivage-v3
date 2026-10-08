import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SelectedCompactedContext from '../../components/agents/SelectedCompactedContext.vue';
import type { AgentConversationResponse } from '../../api/types';
import { entry } from '../tool-presenters/fixtures';

export function compactedContext(): NonNullable<AgentConversationResponse['segment_context']> {
  return {
    kind: 'compacted', source_version: 1, covered_through_message_id: 'covered-source-row',
    summary_text: `${'Full safe historical summary. '.repeat(100)}final-summary-Z`,
    protected_prompts: Array.from({ length: 7 }, (_, index) => ({
      source: { segment_version: 1, row_index: index },
      message: { ...entry(`protected-${index}`, 'text', `Complete instruction ${index} final-instruction-Z`), context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: false } },
    })),
    required_model_facts: { latestRecovery: null, latestContentPolicyRefusal: null },
    continuation: { kind: 'inherited_open_round', activation: { marker_id: 'real-marker', input_id: '11111111-1111-4111-8111-111111111111' }, active_segment_kind: 'initial' },
  };
}

describe('selected actual compacted context', () => {
  it('has independent initially closed full-value disclosures, including the last instruction and real continuation', async () => {
    const context = compactedContext();
    const wrapper = mount(SelectedCompactedContext, { props: { context, version: 2 } });
    expect(wrapper.findAll('details').every(detail => !(detail.element as HTMLDetailsElement).open)).toBe(true);
    expect(wrapper.get('summary').text()).toBe('Compacted context · from segment 1');
    expect(wrapper.text()).toContain('Selected segment 2 · inherited open round');
    const summary = wrapper.get('[data-testid="compacted-summary"]');
    (summary.element as HTMLDetailsElement).open = true;
    expect(summary.get('pre').text()).toBe(context.summary_text);
    expect((wrapper.get('[data-testid="compacted-facts"]').element as HTMLDetailsElement).open).toBe(false);
    expect(wrapper.findAll('li')).toHaveLength(7);
    expect(wrapper.findAll('li').at(-1)!.text()).toContain('Complete instruction 6 final-instruction-Z');
    expect(wrapper.findAll('li').at(-1)!.text()).toContain('Segment 1, row 6 · protected-6');
    expect(wrapper.get('[data-testid="compacted-source"]').text()).toContain('real-marker');
    expect(wrapper.text()).toContain('not another activation entry');
    expect(wrapper.text()).toContain('Latest recovery notice — absent');
    expect(wrapper.get('[data-testid="compacted-source"] pre').element.textContent).toBe(JSON.stringify(context.continuation, null, 2));
    expect(wrapper.get('[data-testid="compacted-source"]').find('.json-token-key').exists()).toBe(true);
    expect(summary.find('.json-text').exists()).toBe(false);
    const instructionBodies = wrapper.findAll('li').at(-1)!.findAll('pre');
    expect(instructionBodies[0].find('.json-token-key').exists()).toBe(true);
    expect(instructionBodies[1].find('.json-text').exists()).toBe(false);
    await wrapper.setProps({ context: { ...context, continuation: { kind: 'between_rounds' } } });
    expect(wrapper.text()).toContain('between rounds');
    expect((summary.element as HTMLDetailsElement).open).toBe(true);
  });
});
