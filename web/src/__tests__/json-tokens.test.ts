import { describe, expect, it } from 'vitest';
import { jsonTokens } from '../utils/json-tokens';

describe('lossless JSON lexical decoration', () => {
  it.each([
    '{"nested":[true,false,null,{"key":"value"}]}',
    ' \r\n{\t"escaped\\\"key" : "\\\\\\u0041 ☃ 😀 & </code><img src=x onerror=alert(1)>"}\n\t',
    '{"dup":1,"dup":900719925474099312345,"zero":-0,"n":-0.00e+2,"e":1E-12}',
    'true', 'false', 'null', '42', '"top-level string"', '[1,2,3]',
    '{"unfinished":"value\\', '{broken:: true, 01, ??}', '',
  ])('preserves every source code unit: %s', (source) => {
    expect(jsonTokens(source).map(token => token.text).join('')).toBe(source);
  });

  it('classifies keys by following JSON whitespace/colon, and leaves nested encoded JSON a string', () => {
    const tokens = jsonTokens('{"key" \r\n\t: "{\\"inner\\":true}","n":-0.25e+2,"b":false,"nil":null}');
    expect(tokens.filter(token => token.kind === 'key').map(token => token.text)).toEqual(['"key"', '"n"', '"b"', '"nil"']);
    expect(tokens.find(token => token.kind === 'string')?.text).toBe('"{\\"inner\\":true}"');
    expect(tokens.find(token => token.kind === 'number')?.text).toBe('-0.25e+2');
    expect(tokens.find(token => token.kind === 'boolean')?.text).toBe('false');
    expect(tokens.find(token => token.kind === 'null')?.text).toBe('null');
  });

  it('coalesces plain runs and leaves unterminated string tails literal', () => {
    expect(jsonTokens('??? \t"unfinished\\')).toEqual([{ kind: 'plain', text: '??? \t"unfinished\\' }]);
    expect(jsonTokens('"complete"')).toEqual([{ kind: 'string', text: '"complete"' }]);
  });
});
