export type JsonTokenKind = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punctuation' | 'plain';
interface JsonToken { kind: JsonTokenKind; text: string }

export const JSON_HIGHLIGHT_LIMIT = 1_000_000;

/** Lossless lexical decoration only: malformed text is still ordinary display text. */
export function jsonTokens(source: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const literal = /true|false|null/y;
  let position = 0;
  let plainStart = 0;
  function emit(kind: JsonTokenKind, end: number): void {
    if (plainStart < position) tokens.push({ kind: 'plain', text: source.slice(plainStart, position) });
    tokens.push({ kind, text: source.slice(position, end) });
    position = end;
    plainStart = end;
  }
  while (position < source.length) {
    const char = source[position];
    if (char === '"') {
      let end = position + 1;
      while (end < source.length && source[end] !== '"') {
        end += source[end] === '\\' ? 2 : 1;
      }
      if (end >= source.length) { position = source.length; break; }
      end += 1;
      let next = end;
      while (next < source.length && /[\x20\t\r\n]/.test(source[next])) next += 1;
      emit(source[next] === ':' ? 'key' : 'string', end);
    } else if ('{}[]:,'.includes(char)) {
      emit('punctuation', position + 1);
    } else {
      number.lastIndex = position;
      literal.lastIndex = position;
      const match = number.exec(source) ?? literal.exec(source);
      if (match) emit(match[0] === 'null' ? 'null' : match[0] === 'true' || match[0] === 'false' ? 'boolean' : 'number', position + match[0].length);
      else position += 1;
    }
  }
  if (plainStart < source.length) tokens.push({ kind: 'plain', text: source.slice(plainStart) });
  return tokens;
}
