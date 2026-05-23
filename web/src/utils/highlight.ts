import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import typescript from 'highlight.js/lib/languages/typescript';
import plaintext from 'highlight.js/lib/languages/plaintext';

const REGISTERED = new Set<string>();

function registerLanguage(name: string, def: (hljs: typeof import('highlight.js/lib/core').default) => unknown): void {
  if (REGISTERED.has(name)) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hljs.registerLanguage(name, def as any);
  REGISTERED.add(name);
}

registerLanguage('json', json);
registerLanguage('bash', bash);
registerLanguage('diff', diff);
registerLanguage('typescript', typescript);
registerLanguage('plaintext', plaintext);

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(input: string): string {
  return input.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]);
}

/**
 * Highlight `code` using the registered hljs languages. Returns HTML-safe
 * markup: when `language` is supported, hljs produces escaped output with
 * `<span class="hljs-..">` wrappers; otherwise we escape manually so callers
 * may safely use `v-html`. Pure: never throws.
 */
export function highlight(code: string, language?: string): string {
  if (typeof code !== 'string' || code.length === 0) {
    return '';
  }
  const lang = language && REGISTERED.has(language) ? language : null;
  if (lang) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(code);
    }
  }
  return escapeHtml(code);
}

export { hljs };
