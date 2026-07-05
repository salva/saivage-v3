import { ref, watch, readonly, type Ref } from 'vue';
import { getFileContent, ApiError } from '../api/client';
import { createLogger } from '../utils/logger';

const log = createLogger('composable:card-records');

export type RecordSlot = 'brief' | 'status' | 'review';

export interface RecordSlotState {
  slot: RecordSlot;
  loading: boolean;
  error: string | null;
  version: number | null;
  content: string | null;
  exists: boolean;
}

export type CardRecordsState = Record<RecordSlot, RecordSlotState>;

function emptySlot(slot: RecordSlot): RecordSlotState {
  return { slot, loading: false, error: null, version: null, content: null, exists: false };
}

function emptyState(): CardRecordsState {
  return { brief: emptySlot('brief'), status: emptySlot('status'), review: emptySlot('review') };
}

const SLOTS: RecordSlot[] = ['brief', 'status', 'review'];
const OUTPUTS_ROOT = '.saivage/outputs/cards';

interface RecordSlotIndex {
  slot: string;
  latest: number | null;
  open: number | null;
  versions: Record<string, unknown>;
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    const res = await getFileContent(path);
    return JSON.parse(res.content) as unknown;
  } catch (err) {
    if (err instanceof ApiError && err.isNotFound) return null;
    throw err;
  }
}

async function fetchSlot(cardId: string, slot: RecordSlot): Promise<RecordSlotState> {
  const base = `${OUTPUTS_ROOT}/${cardId}/${slot}`;
  const state: RecordSlotState = { slot, loading: false, error: null, version: null, content: null, exists: false };
  const parsed = await readJson(`${base}/index.json`);
  if (!parsed) return state;
  const index = parsed as RecordSlotIndex;
  const version = index.latest ?? null;
  if (version === null) return state;
  try {
    const res = await getFileContent(`${base}/${version}.md`);
    state.version = version;
    state.content = res.content;
    state.exists = true;
  } catch (err) {
    if (err instanceof ApiError && err.isNotFound) return state;
    state.error = err instanceof Error ? err.message : String(err);
  }
  return state;
}

export interface UseCardRecords {
  state: Readonly<Ref<CardRecordsState>>;
  loading: Ref<boolean>;
  refresh: () => Promise<void>;
}

export function useCardRecords(cardId: Ref<string | null | undefined>): UseCardRecords {
  const state = ref<CardRecordsState>(emptyState());
  const loading = ref(false);

  async function load(id: string): Promise<void> {
    loading.value = true;
    const next = emptyState();
    await Promise.all(
      SLOTS.map(async (slot) => {
        try {
          next[slot] = await fetchSlot(id, slot);
        } catch (err) {
          next[slot] = { slot, loading: false, error: err instanceof Error ? err.message : String(err), version: null, content: null, exists: false };
          log.error('fetchSlot failed', slot, err);
        }
      }),
    );
    state.value = next;
    loading.value = false;
  }

  async function refresh(): Promise<void> {
    const id = cardId.value;
    if (!id) {
      state.value = emptyState();
      return;
    }
    await load(id);
  }

  watch(
    cardId,
    (id) => {
      if (!id) {
        state.value = emptyState();
        loading.value = false;
        return;
      }
      void load(id);
    },
    { immediate: true },
  );

  return { state: readonly(state) as unknown as Readonly<Ref<CardRecordsState>>, loading: readonly(loading), refresh };
}
