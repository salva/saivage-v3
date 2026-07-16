import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { listCards, publishInitialCard, publishInitialProjectCard, readCard, readCardIndex } from '../../src/persistence/card-files.js';
import type { CardRecord } from '../../src/schemas/index.js';

const CARD_ID = '11111111-1111-4111-8111-111111111111';
const BRIEF_TEMP = '22222222-2222-4222-8222-222222222222';
const CARD_TEMP = '33333333-3333-4333-8333-333333333333';

function card(id: string, type: CardRecord['type'], parent: string | null): CardRecord {
  const stamp = '2026-07-15T00:00:00.000Z';
  return {
    id, type, parent, depth: parent === null ? 0 : 1, position: 0, title: type, status: 'backlog',
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, tags: [], priority: 0,
    urgency: 'normal', created_by: 'analyst', created_at: stamp, updated_at: stamp, version_seq: 1,
    depends_on: [], related: [], pending_notifications: [],
  };
}

describe('direct card publication UUID seams', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-card-files-'));
    mkdirSync(join(root, '.saivage', 'cards'), { recursive: true });
    publishInitialProjectCard(root, card('project', 'project', null), '# project', 'analyst', () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });
  afterEach(() => rmSync(root, { recursive: true }));

  test('calls the card identity factory once and the publication factory once per physical target', () => {
    const identity = jest.fn<() => string>(() => CARD_ID);
    const temporary = jest.fn<() => string>().mockReturnValueOnce(BRIEF_TEMP).mockReturnValueOnce(CARD_TEMP);
    const input = card(CARD_ID, 'code', 'project');
    const { id: _id, ...withoutId } = input;

    const published = publishInitialCard(root, withoutId, '# work', 'analyst', identity, temporary);

    expect(published.id).toBe(CARD_ID);
    expect(identity).toHaveBeenCalledTimes(1);
    expect(temporary).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(join(root, '.saivage', 'cards', CARD_ID, 'brief', 'versions', '1.json'), 'utf8')).card_id).toBe(CARD_ID);
    expect(JSON.parse(readFileSync(join(root, '.saivage', 'cards', CARD_ID, 'card', 'versions', '1.json'), 'utf8')).card.id).toBe(CARD_ID);
  });

  test('does not ask for another card id after namespace collision', () => {
    mkdirSync(join(root, '.saivage', 'cards', CARD_ID));
    const identity = jest.fn<() => string>(() => CARD_ID);
    const input = card(CARD_ID, 'code', 'project');
    const { id: _id, ...withoutId } = input;

    expect(() => publishInitialCard(root, withoutId, '# work', 'analyst', identity)).toThrow();
    expect(identity).toHaveBeenCalledTimes(1);
  });

  test('leaves brief-only crash prefixes invisible and never adopts or removes them', () => {
    const identity = jest.fn<() => string>(() => CARD_ID);
    const temporary = jest.fn<() => string>(() => {
      if (temporary.mock.calls.length === 2) {
        const collision = join(root, '.saivage', 'cards', CARD_ID, 'card', 'versions', `.1.json.${CARD_TEMP}.saivage-tmp`);
        mkdirSync(join(root, '.saivage', 'cards', CARD_ID, 'card', 'versions'), { recursive: true });
        writeFileSync(collision, 'crash-left');
        return CARD_TEMP;
      }
      return BRIEF_TEMP;
    });
    const { id: _id, ...withoutId } = card(CARD_ID, 'code', 'project');

    expect(() => publishInitialCard(root, withoutId, '# work', 'analyst', identity, temporary)).toThrow();
    expect(identity).toHaveBeenCalledTimes(1);
    expect(temporary).toHaveBeenCalledTimes(2);
    expect(readCard(root, CARD_ID)).toBeNull();
    expect(listCards(root).map(({ id }) => id)).toEqual(['project']);
    expect(existsSync(join(root, '.saivage', 'cards', CARD_ID, 'brief', 'versions', '1.json'))).toBe(true);
    expect(existsSync(join(root, '.saivage', 'cards', CARD_ID))).toBe(true);
  });

  test('silently ignores namespace-only, temp-only, and arbitrary noncanonical entries', () => {
    mkdirSync(join(root, '.saivage', 'cards', CARD_ID));
    mkdirSync(join(root, '.saivage', 'cards', 'not-a-card'));
    writeFileSync(join(root, '.saivage', 'cards', CARD_ID, '.1.json.44444444-4444-4444-8444-444444444444.saivage-tmp'), 'orphan');
    writeFileSync(join(root, '.saivage', 'cards', 'unknown-file'), 'ignored');

    expect(readCardIndex(root).cards.size).toBe(1);
    expect(readCardIndex(root).tombstonedIds.size).toBe(0);
    expect(existsSync(join(root, '.saivage', 'cards', CARD_ID))).toBe(true);
    expect(existsSync(join(root, '.saivage', 'cards', 'unknown-file'))).toBe(true);
  });
});
