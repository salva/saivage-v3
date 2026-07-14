import { describe, expect, it } from '@jest/globals';

import {
  parseCardVersionArtifact,
  parseCardVersionFilename,
  parseRecordVersionArtifact,
  selectCurrentCardVersion,
  type CardVersionArtifact,
} from '../../src/persistence/index.js';
import type { CardRecord } from '../../src/schemas/index.js';

const stamp = '2026-07-13T12:00:00.000Z';

function card(version = 1, overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: 'project', type: 'project', parent: null, depth: 0, position: 0, title: 'Project', status: 'backlog',
    subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: stamp,
    updated_at: stamp, assigned_to: null, depends_on: [], related: [],
    lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, metrics: null, estimate: null,
    started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null,
    status_text_author_session_id: null, latest_self_report: null, retries: 0, version_seq: version, ...overrides,
  };
}

function cardArtifact(version = 1): CardVersionArtifact {
  return {
    kind: 'card-version', format_version: 1, card_id: 'project', version, committed_at: stamp,
    card: card(version),
    history: version === 1 ? null : {
      entry_id: '11111111-1111-4111-8111-111111111111', kind: 'update', card_id: 'project', version_seq: version - 1,
      snapshot: card(version - 1), changed_at: stamp, changed_by_actor: 'analyst', changed_by_surface: 'web-chat',
      change_reason: 'test', changed_fields: ['title'], change_summary: 'test update',
    },
  };
}

function recordArtifact(state: 'open' | 'closed' | 'discarded') {
  return {
    kind: 'record-version', format_version: 1, card_id: 'project', slot: 'brief', version: 1, state,
    opened_at: stamp,
    committed_at: state === 'closed' ? stamp : null,
    closed_at: state === 'closed' ? stamp : null,
    discarded_at: state === 'discarded' ? stamp : null,
    reason: state === 'discarded' ? 'abandoned' : null,
    writer: state === 'closed' ? 'analyst' : null,
    format: 'markdown', schema: 'record.brief.markdown.v1',
    card_version_seq: state === 'closed' ? 1 : null,
    content: state === 'closed' ? '# Goal' : '',
  };
}

describe('canonical card artifact parsers', () => {
  it('accepts only canonical positive decimal filenames', () => {
    expect(parseCardVersionFilename('1.json')).toBe(1);
    for (const filename of ['0.json', '01.json', '+1.json', '1.0.json', '1.JSON', 'x.json', '1.json.tmp']) {
      expect(() => parseCardVersionFilename(filename, `/versions/${filename}`)).toThrow(`/versions/${filename}`);
    }
    expect(() => parseCardVersionFilename(`${Number.MAX_SAFE_INTEGER}0.json`)).toThrow(/safe integer/);
  });

  it('strictly validates envelope, path identity, lifecycle, history, and unknown keys', () => {
    expect(parseCardVersionArtifact(cardArtifact(), '/versions/1.json', { cardId: 'project', version: 1 })).toEqual(cardArtifact());
    expect(() => parseCardVersionArtifact({ ...cardArtifact(), extra: true }, '/versions/1.json')).toThrow(/unrecognized/i);
    expect(() => parseCardVersionArtifact({ ...cardArtifact(), card_id: 'other' }, '/versions/1.json')).toThrow(/inconsistent envelope/);
    expect(() => parseCardVersionArtifact(cardArtifact(2), '/versions/1.json', { cardId: 'project', version: 1 })).toThrow(/does not match/);
    expect(() => parseCardVersionArtifact({ ...cardArtifact(2), history: null }, '/versions/2.json')).toThrow(/requires a history/);
  });

  it('selects one unambiguous current card version', () => {
    expect(selectCurrentCardVersion([cardArtifact(1), cardArtifact(2)], '/versions')).toEqual(cardArtifact(2));
    expect(() => selectCurrentCardVersion([], '/versions')).toThrow(/No canonical/);
    expect(() => selectCurrentCardVersion([cardArtifact(1), cardArtifact(1)], '/versions')).toThrow(/Ambiguous/);
  });
});

describe('canonical authored-record artifact parsers', () => {
  it.each(['open', 'closed', 'discarded'] as const)('accepts a valid %s artifact', (state) => {
    expect(parseRecordVersionArtifact(recordArtifact(state), '/brief/versions/1.json', { cardId: 'project', slot: 'brief', version: 1 }).state).toBe(state);
  });

  it('rejects unknown format, identity, registry, writer, and contradictory state metadata', () => {
    expect(() => parseRecordVersionArtifact({ ...recordArtifact('open'), format_version: 2 }, '/record')).toThrow(/invalid/);
    expect(() => parseRecordVersionArtifact({ ...recordArtifact('open'), extra: true }, '/record')).toThrow(/unrecognized/i);
    expect(() => parseRecordVersionArtifact(recordArtifact('open'), '/record', { cardId: 'other', slot: 'brief', version: 1 })).toThrow(/does not match/);
    expect(() => parseRecordVersionArtifact({ ...recordArtifact('closed'), schema: 'wrong' }, '/record')).toThrow(/schema/);
    expect(() => parseRecordVersionArtifact({ ...recordArtifact('closed'), writer: 'reviewer' }, '/record')).toThrow(/writer/);
    expect(() => parseRecordVersionArtifact({ ...recordArtifact('open'), committed_at: stamp }, '/record')).toThrow(/committed_at/);
    expect(() => parseRecordVersionArtifact({ ...recordArtifact('closed'), content: '  ' }, '/record')).toThrow(/non-empty/);
    expect(() => parseRecordVersionArtifact({ ...recordArtifact('discarded'), reason: null }, '/record')).toThrow(/reason/);
  });

});
