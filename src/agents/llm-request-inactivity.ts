import type { LlmResponseConsumption } from '../contracts/index.js';

const PROVIDER_INACTIVITY_MS = 120_000;

export class ProviderInactivityTimeoutError extends Error {
  constructor() {
    super('Provider request inactive for 120000 ms.');
    this.name = 'ProviderInactivityTimeoutError';
  }
}

export async function consumeProviderRequest<T>(
  input: string,
  init: Omit<RequestInit, 'signal'>,
  ownerSignal: AbortSignal | undefined,
  consume: (response: Response, context: LlmResponseConsumption) => Promise<T>,
): Promise<T> {
  ownerSignal?.throwIfAborted();
  const controller = new AbortController();
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  const onOwnerAbort = (): void => {
    clear();
    controller.abort(ownerSignal!.reason);
  };
  const onData = (): void => {
    if (!active || controller.signal.aborted) return;
    clear();
    timer = setTimeout(() => {
      if (!active || controller.signal.aborted) return;
      controller.abort(new ProviderInactivityTimeoutError());
    }, PROVIDER_INACTIVITY_MS);
  };
  const context: LlmResponseConsumption = {
    signal: controller.signal,
    onData,
    async readText(response) {
      if (!response.body) return '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return text + decoder.decode();
          if (value.byteLength > 0) onData();
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
  ownerSignal?.addEventListener('abort', onOwnerAbort, { once: true });
  onData();
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return await consume(response, context);
  } catch (error) {
    // Fetch body readers may surface AbortError rather than the supplied reason.
    // Only abort-associated outcomes belong to this scope; native failures keep authority.
    if (
      controller.signal.aborted &&
      (error === controller.signal.reason ||
        (error instanceof Error && error.name === 'AbortError'))
    ) {
      if (ownerSignal?.aborted) throw ownerSignal.reason;
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    active = false;
    clear();
    ownerSignal?.removeEventListener('abort', onOwnerAbort);
  }
}
