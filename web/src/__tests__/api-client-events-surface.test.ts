import { describe, expect, it } from 'vitest';
import * as client from '../api/client';
import * as types from '../api/types';
import clientSource from '../api/client.ts?raw';
import typesSource from '../api/types.ts?raw';

const name = (...parts: string[]) => parts.join('');
const clientNames = [name('list', 'Notifications'), name('list', 'Notes')];
const typeNames = [
  name('Notification', 'Record'),
  name('Notifications', 'ListResponse'),
  name('NoteQueue', 'Entry'),
  name('Notes', 'ListResponse'),
];

describe('operator events API client surface', () => {
  it('does not export notification or notes list client functions', () => {
    for (const exportedName of clientNames) {
      expect((client as Record<string, unknown>)[exportedName]).toBeUndefined();
      expect(clientSource).not.toContain(exportedName);
    }
  });

  it('does not export notification or note queue response types', () => {
    for (const exportedName of typeNames) {
      expect((types as Record<string, unknown>)[exportedName]).toBeUndefined();
      expect(typesSource).not.toContain(exportedName);
    }
  });
});
