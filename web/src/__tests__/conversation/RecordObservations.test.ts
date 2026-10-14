import { mount, flushPromises } from '@vue/test-utils';
import { describe, it, expect, vi } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';
import ConversationTimeline from '../../components/conversation/ConversationTimeline.vue';
import SelectedCompactedContext from '../../components/agents/SelectedCompactedContext.vue';
import { entriesToTimeline } from '../../utils/agent-timeline';
import { entry } from '../tool-presenters/fixtures';
import type { AgentConversationEntry } from '../../api/types';

describe('record observation evidence in shared current/historical readers', () => {
  it('keeps actual prompt bytes in order and inherited slice facts at original coordinates without a new timeline occurrence', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/files', name: 'files', component: { template: '<div />' } }] });
    await router.push('/'); await router.isReady();
    const observations: NonNullable<AgentConversationEntry['record_observations']> = [{
      observed: { card_id: 'card-a', record_name: 'status.md', view: 'effective', selection_kind: 'current', head: { head_id: '11111111-1111-4111-8111-111111111111', revision: 3 }, selection: { kind: 'draft', accepted_backing: { kind: 'accepted', entry_id: '22222222-2222-4222-8222-222222222222', version: 1, locator: 'record:///status.md?card=card-a&v=1' } }, exposure: { kind: 'slice', offset_bytes: 12, utf8_bytes: 20, total_bytes: 90 } },
      source: { kind: 'read', input_id: '11111111-1111-4111-8111-111111111111', tool_call_id: 'read-1', tool_name: 'read' },
    }];
    const first = entry('actual-prompt-A', 'record_prompt', 'Actual A bytes\nFINAL-A', { instruction_origin: 'workflow_prompt', record_prompt: { reference: 'changed', node_id: 'execute', reason: 'initial' } });
    const second = entry('actual-prompt-B', 'record_prompt', 'Actual B bytes\nFINAL-B', { instruction_origin: 'workflow_prompt', record_prompt: { reference: 'changed', node_id: 'verify', reason: 'changed' } });
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    const timeline = mount(ConversationTimeline, { props: { timeline: entriesToTimeline([first, second]), expandedIds: new Set<string>() }, global: { plugins: [router] } });
    expect(timeline.findAll('[data-entry-id]').map(row => row.attributes('data-entry-id'))).toEqual([first.id, second.id]);
    await timeline.get(`[data-entry-id="${second.id}"] button`).trigger('click');
    expect(copy).toHaveBeenLastCalledWith(second.content);
    const source = { segmentVersion: 1, rowIndex: 7, messageId: 'original-read-result', timestamp: '2026-10-13T00:00:00Z' };
    const context = mount(SelectedCompactedContext, { props: { version: 2, context: { kind: 'compacted', source_version: 1, covered_through_message_id: source.messageId, summary_text: 'Summary does not recall body', protected_prompts: [], required_model_facts: { latestRecovery: null, latestContentPolicyRefusal: null, latestRecordObservations: [{ source, observation: observations[0] }] }, continuation: { kind: 'between_rounds' } } }, global: { plugins: [router] } });
    expect(context.text()).toContain('segment 1, row 7, original-read-result');
    expect(context.text()).toContain(source.timestamp);
    expect(context.text()).toContain('Selection: draft · Exposure: slice · bytes 12 + 20 of 90');
    expect(context.text()).toContain('not new observations');
    expect(context.find('[data-entry-id]').exists()).toBe(false);
    await context.get('button').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.path).toBe('record:///status.md?card=card-a&v=1');
    timeline.unmount(); context.unmount();
  });
});
