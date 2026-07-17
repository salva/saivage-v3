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
  it('uses one direct canonical card scan without general CardService read detours', () => {
    const serviceSource = readFileSync(join(root, 'src/cards/card-service.ts'), 'utf8');
    const cardFilesSource = readFileSync(join(root, 'src/persistence/card-files.ts'), 'utf8');

    const admission = functionBody(serviceSource, 'readActivationAdmission(cardId: string)');
    expect(admission.match(/listCards\(this\.projectRoot\)/g)).toHaveLength(1);
    for (const forbidden of [/this\.state\s*\(/, /this\.read\s*\(/, /this\.list\s*\(/, /readCardIndex\s*\(/]) {
      expect(admission).not.toMatch(forbidden);
    }

    const list = functionBody(cardFilesSource, 'export function listCards(projectRoot: string)');
    expect(list.match(/readCardIndex\(projectRoot\)/g)).toHaveLength(1);

    const index = functionBody(cardFilesSource, 'export function readCardIndex(projectRoot: string)');
    expect(index.match(/scanCardIndex\(cardsRoot\(projectRoot\)\)/g)).toHaveLength(1);
  });
});
