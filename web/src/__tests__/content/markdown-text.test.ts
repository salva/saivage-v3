import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MarkdownText from '../../components/content/MarkdownText.vue';
import CodeBlock from '../../components/content/CodeBlock.vue';

describe('MarkdownText', () => {
  it('renders nothing children for empty input', () => {
    const wrapper = mount(MarkdownText, { props: { source: '' } });
    expect(wrapper.findComponent(CodeBlock).exists()).toBe(false);
    expect(wrapper.findAll('code.inline-token')).toHaveLength(0);
    expect(wrapper.findAll('span.md-text')).toHaveLength(0);
  });

  it('renders a single md-text span for plain text', () => {
    const wrapper = mount(MarkdownText, { props: { source: 'hello' } });
    const spans = wrapper.findAll('span.md-text');
    expect(spans).toHaveLength(1);
    expect(spans[0].text()).toBe('hello');
    expect(wrapper.findComponent(CodeBlock).exists()).toBe(false);
  });

  it('uses CodeBlock for fenced segments', () => {
    const wrapper = mount(MarkdownText, { props: { source: '```json\n{"a":1}\n```' } });
    const cb = wrapper.findComponent(CodeBlock);
    expect(cb.exists()).toBe(true);
    const cbProps = cb.props() as { language?: string; code?: string };
    expect(cbProps.language).toBe('json');
    expect(cbProps.code).toBe('{"a":1}\n');
  });

  it('uses inline-token <code> for inline segments', () => {
    const wrapper = mount(MarkdownText, { props: { source: 'a `b` c' } });
    expect(wrapper.findAll('code.inline-token')).toHaveLength(1);
    expect(wrapper.find('code.inline-token').text()).toBe('b');
  });

  it('renders mixed text/inline/fence in order', () => {
    const wrapper = mount(MarkdownText, {
      props: { source: 'before `inline` mid\n```bash\nls\n```\nafter' },
    });
    const codeBlocks = wrapper.findAllComponents(CodeBlock);
    expect(codeBlocks).toHaveLength(1);
    expect((codeBlocks[0].props() as { language?: string }).language).toBe('bash');
    expect(wrapper.findAll('code.inline-token')).toHaveLength(1);
    expect(wrapper.findAll('span.md-text').length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to text language for unknown fenced language', () => {
    const wrapper = mount(MarkdownText, { props: { source: '```cobol\nfoo\n```' } });
    const cb = wrapper.findComponent(CodeBlock);
    expect((cb.props() as { language?: string }).language).toBe('text');
  });
});
