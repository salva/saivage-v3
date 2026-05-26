import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import FormattedContent from '../../components/content/FormattedContent.vue';
import JsonView from '../../components/content/JsonView.vue';
import MarkdownText from '../../components/content/MarkdownText.vue';
import CodeBlock from '../../components/content/CodeBlock.vue';

describe('FormattedContent', () => {
  it('renders JSON values through JsonView', () => {
    const wrapper = mount(FormattedContent, { props: { kind: 'json', value: { ok: true }, copyable: true } });
    expect(wrapper.findComponent(JsonView).exists()).toBe(true);
    expect(wrapper.find('.json-token-view').text()).toContain('"ok": true');
  });

  it('renders markdown through MarkdownText', () => {
    const wrapper = mount(FormattedContent, { props: { kind: 'markdown', value: 'hello `world`' } });
    expect(wrapper.findComponent(MarkdownText).exists()).toBe(true);
    expect(wrapper.find('code.inline-token').text()).toBe('world');
  });

  it('renders text through CodeBlock', () => {
    const wrapper = mount(FormattedContent, { props: { value: 'plain', wrap: true } });
    const block = wrapper.findComponent(CodeBlock);
    expect(block.exists()).toBe(true);
    expect(block.props('code')).toBe('plain');
    expect(block.props('wrap')).toBe(true);
  });
});
