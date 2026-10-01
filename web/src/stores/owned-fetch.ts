import { ref } from 'vue';

/** Only request lifetime; acceptance and error policy belong to the caller. */
export function createOwnedFetch() {
  const pending = ref(false);
  let current: AbortController | null = null;

  function cancel(): void {
    const previous = current;
    current = null;
    pending.value = false;
    previous?.abort();
  }

  async function run<T>(
    load: (signal: AbortSignal) => Promise<T>,
    accept: (value: T) => void,
    reject: (error: unknown) => void,
  ): Promise<void> {
    cancel();
    const owner = new AbortController();
    current = owner;
    pending.value = true;
    try {
      let value: T;
      try {
        value = await load(owner.signal);
      } catch (error) {
        if (current === owner && !owner.signal.aborted) reject(error);
        return;
      }
      if (current === owner && !owner.signal.aborted) accept(value);
    } finally {
      if (current === owner) {
        current = null;
        pending.value = false;
      }
    }
  }

  return { pending, run, cancel };
}
