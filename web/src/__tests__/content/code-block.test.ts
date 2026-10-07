import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import CodeBlock from '../../components/content/CodeBlock.vue';

describe('CodeBlock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders <pre> with language class for json', () => {
    const wrapper = mount(CodeBlock, { props: { code: '{"a":1}', language: 'json' } });
    const pre = wrapper.find('pre');
    expect(pre.exists()).toBe(true);
    expect(pre.classes()).toContain('language-json');
  });

  it('decorates JSON keys and numbers with lossless text tokens', () => {
    const wrapper = mount(CodeBlock, { props: { code: '{"a":1}', language: 'json' } });
    expect(wrapper.find('.json-token-key').text()).toBe('"a"');
    expect(wrapper.find('.json-token-number').text()).toBe('1');
    expect(wrapper.find('code').element.textContent).toBe('{"a":1}');
  });

  it('shows a copy button only when copyable', () => {
    const off = mount(CodeBlock, { props: { code: 'x', language: 'text' } });
    expect(off.find('button.code-block__copy').exists()).toBe(false);
    const on = mount(CodeBlock, { props: { code: 'x', language: 'text', copyable: true } });
    expect(on.find('button.code-block__copy').exists()).toBe(true);
  });

  it('calls navigator.clipboard.writeText with the exact code prop on copy click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText } },
    });
    const wrapper = mount(CodeBlock, { props: { code: 'hello\nworld', language: 'text', copyable: true } });
    await wrapper.find('button.code-block__copy').trigger('click');
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('hello\nworld');
  });

  it('falls back to document.execCommand when navigator.clipboard is missing', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    });
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: exec,
    });
    const wrapper = mount(CodeBlock, { props: { code: 'fallback', language: 'text', copyable: true } });
    await wrapper.find('button.code-block__copy').trigger('click');
    await Promise.resolve();
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('reflects maxHeight via inline style', () => {
    const wrapper = mount(CodeBlock, { props: { code: 'x', language: 'text', maxHeight: '40vh' } });
    const pre = wrapper.find('pre');
    expect(pre.attributes('style') ?? '').toContain('max-height');
    expect(pre.attributes('style') ?? '').toContain('40vh');
  });

  it('toggles whitespace style when wrap is set', () => {
    const off = mount(CodeBlock, { props: { code: 'x', language: 'text' } });
    expect(off.find('pre').attributes('style') ?? '').toContain('white-space: pre');
    const on = mount(CodeBlock, { props: { code: 'x', language: 'text', wrap: true } });
    expect(on.find('pre').attributes('style') ?? '').toContain('white-space: pre-wrap');
    expect(on.classes()).toContain('code-block--wrap');
  });

  it('escapes XSS-style input and does not introduce raw <script> tag into DOM', () => {
    const wrapper = mount(CodeBlock, { props: { code: '<script>alert(1)</script>', language: 'json' } });
    const html = wrapper.html();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders an exact plain path above the code-unit highlighting limit', () => {
    const big = 'a'.repeat(1_000_001);
    const wrapper = mount(CodeBlock, { props: { code: big, language: 'json' } });
    expect(wrapper.find('.highlighting-disabled').exists()).toBe(true);
    expect(wrapper.find('.highlighting-disabled').text()).toContain('Syntax highlighting disabled');
    expect(wrapper.find('.highlighting-disabled').text()).toContain('UTF-16 code units');
    expect(wrapper.find('[class^="json-token-"]').exists()).toBe(false);
    expect(wrapper.find('code').element.textContent).toBe(big);
  });

  it('sets aria-label on the pre element when provided', () => {
    const wrapper = mount(CodeBlock, { props: { code: 'x', language: 'text', ariaLabel: 'request body' } });
    expect(wrapper.find('pre').attributes('aria-label')).toBe('request body');
  });
});
