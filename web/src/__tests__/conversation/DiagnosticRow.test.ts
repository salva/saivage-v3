import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import DiagnosticRow from '../../components/conversation/DiagnosticRow.vue';
import { entry } from '../tool-presenters/fixtures';
import { MODEL_RECOVERY_NOTICE_TEXT } from '@saivage/schemas/context-policy';
describe('diagnostic evidence', () => {
  it.each([
    ['model_issue', 'Provider rejected request. '.repeat(20) + 'FINAL-Z', 'Model issue'],
    ['model_repair', 'Return the required valid node result. FINAL-Z', 'Repair instruction recorded'],
    ['model_recovered', MODEL_RECOVERY_NOTICE_TEXT, 'Interrupted activation · effects uncertain'],
  ] as const)('keeps %s truthful closed and preserves full body/provenance', async (kind, content, label) => {
    const source = entry('diagnostic', kind, content, { role: kind === 'model_repair' ? 'user' : 'system', context_policy: kind === 'model_repair' ? { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true } : { kind: 'structural', behavior: kind === 'model_issue' ? 'provider_failure' : 'model_recovery_notice' } });
    const wrapper = mount(DiagnosticRow, { props: { entry: source } });
    const details = wrapper.get('details').element as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(wrapper.attributes('tabindex')).toBe('-1');
    expect(wrapper.attributes('data-entry-id')).toBe(source.id);
    expect(wrapper.get('details').attributes('data-entry-id')).toBeUndefined();
    expect(wrapper.get('details').attributes('tabindex')).toBeUndefined();
    expect(wrapper.get('summary').attributes('tabindex')).toBe('0');
    expect(wrapper.get('summary').text()).toContain(label);
    expect(wrapper.classes()).not.toContain('success');
    expect(wrapper.get('summary').text()).not.toMatch(/Repaired|Recovered/);
    details.open = true;
    expect(wrapper.get('pre').element.textContent).toBe(content);
    expect(wrapper.text()).toContain(source.timestamp);
    await wrapper.setProps({ entry: { ...source } });
    expect(details.open).toBe(true);
  });
});
