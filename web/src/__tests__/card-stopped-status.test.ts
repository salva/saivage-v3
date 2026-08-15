import { cardStatusValues } from '@saivage/schemas';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { cardStatusTone, statusForCard } from '../utils/status';
import treeSource from '../components/cards/CardsTreeView.vue?raw';

const semanticSource = readFileSync('src/styles/semantic.css', 'utf8');
const tokensSource = readFileSync('src/styles/tokens.css', 'utf8');

function cssVariables(source: string): Map<string, string> {
  return new Map([...source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));
}

function resolveColor(name: string, variables: ReadonlyMap<string, string>): string {
  const value = variables.get(name);
  if (value === undefined) throw new Error(`Missing CSS variable ${name}`);
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  return alias ? resolveColor(alias[1]!, variables) : value.toLowerCase();
}

function contrastAgainstWhite(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const luminance = channels
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  return 1.05 / (luminance + 0.05);
}

describe('stopped card status projection', () => {
  it('maps stopped exhaustively to a distinct, contrasting purple marker without a ring', () => {
    const variables = cssVariables(`${tokensSource}\n${semanticSource}`);
    const stopped = resolveColor('--card-status-stopped', variables);
    const running = resolveColor('--card-status-running', variables);

    expect(Object.keys(cardStatusTone).sort()).toEqual([...cardStatusValues].sort());
    expect(statusForCard('stopped')).toEqual({ label: 'stopped', tone: 'success', indicator: 'stopped-dot', description: undefined });
    expect(statusForCard('cancelled')).toEqual({ label: 'cancelled', tone: 'neutral', description: undefined });
    expect(stopped).toBe('#6f42c1');
    expect(running).toBe('#16a34a');
    expect(stopped).not.toBe(running);
    expect(contrastAgainstWhite(stopped)).toBeGreaterThanOrEqual(3);
    const obsoleteStoppedRing = `${'--card-status-stopped'}-${'ring'}`;
    expect(variables.has(obsoleteStoppedRing)).toBe(false);
    expect(treeSource).toContain('.state-ball.card-status-stopped');
    expect(treeSource).toContain('background:var(--card-status-stopped)');
  });
});
