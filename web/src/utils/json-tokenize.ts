export interface JsonToken { kind: 'punctuation' | 'key' | 'string' | 'number' | 'literal' | 'whitespace'; text: string }

export function tokenizeJson(source: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { const start = i; while (i < source.length && /\s/.test(source[i])) i++; tokens.push({ kind: 'whitespace', text: source.slice(start, i) }); continue; }
    if ('{}[]:,'.includes(ch)) { tokens.push({ kind: 'punctuation', text: ch }); i++; continue; }
    if (ch === '"') { const start = i++; let escaped = false; while (i < source.length) { const c = source[i++]; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') break; } const text = source.slice(start, i); let j = i; while (j < source.length && /\s/.test(source[j])) j++; tokens.push({ kind: source[j] === ':' ? 'key' : 'string', text }); continue; }
    const start = i; while (i < source.length && !/[\s{}\[\]:,]/.test(source[i])) i++; const text = source.slice(start, i); tokens.push({ kind: /^(true|false|null)$/.test(text) ? 'literal' : 'number', text });
  }
  return tokens;
}
