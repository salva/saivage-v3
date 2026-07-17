import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const openingBrace = source.indexOf('{', start);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  throw new Error(`Unclosed source body for '${signature}'.`);
}

describe('card activation admission projection call graph', () => {
  it('uses exact target and dependency reads without list or tree projection', () => {
    const serviceSource = readFileSync(join(root, 'src/cards/card-service.ts'), 'utf8');
    const admission = functionBody(serviceSource, 'readActivationAdmission(cardId: string)');
    expect(admission).toMatch(/this\.read\(cardId\)/);
    expect(admission).toMatch(/child\.depends_on\.map/);
    for (const forbidden of [/this\.state\s*\(/, /this\.list\s*\(/, /listCards\s*\(/]) {
      expect(admission).not.toMatch(forbidden);
    }
  });
});
