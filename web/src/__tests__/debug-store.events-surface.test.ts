import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it } from 'vitest';
import { useDebugStore } from '../stores/debug';
import debugStoreSource from '../stores/debug.ts?raw';

const name = (...parts: string[]) => parts.join('');
const removedStoreExports = [
  name('notifications'),
  name('notifications', 'Total'),
  name('notifications', 'State'),
  name('fetch', 'Notifications'),
  name('operator', 'Notes'),
  name('operator', 'NotesTotal'),
  name('operator', 'NotesLoading'),
  name('operator', 'NotesError'),
  name('fetch', 'Notes'),
];
const removedSourceTokens = [
  name('list', 'Notifications'),
  name('list', 'Notes'),
  name('fetch', 'Notifications'),
  name('fetch', 'Notes'),
  name('Notification', 'Record'),
  name('Notifications', 'ListResponse'),
  name('NoteQueue', 'Entry'),
  name('Notes', 'ListResponse'),
  name('notification', 'ActionLoading'),
  name('server', 'Notifications'),
  name('event', 'NotificationRollups'),
];

describe('debug store operator events surface', () => {
  it('does not expose notification or operator-note state/actions', () => {
    setActivePinia(createPinia());
    const store = useDebugStore() as unknown as Record<string, unknown>;

    for (const exportedName of removedStoreExports) {
      expect(store[exportedName]).toBeUndefined();
    }
  });

  it('does not import or fetch notification or operator-note list surfaces', () => {
    for (const token of removedSourceTokens) {
      expect(debugStoreSource).not.toContain(token);
    }

    const eventName = ['notification', 'added'].join('_');
    const fetchPrefix = name('fetch', 'Notification');
    for (const line of debugStoreSource.split('\n').filter((entry) => entry.includes(eventName))) {
      expect(line).not.toContain(fetchPrefix);
    }
  });
});
