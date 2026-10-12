import type { LlmResponseConsumption } from '../contracts/index.js';

const PROVIDER_INACTIVITY_MS = 120_000;
const PROVIDER_REQUEST_DEADLINE_MS = 15 * 60_000;

export class ProviderRequestDeadlineError extends Error {
  constructor() {
    super(`Provider request exceeded absolute deadline of ${PROVIDER_REQUEST_DEADLINE_MS} ms.`);
    this.name = 'ProviderRequestDeadlineError';
  }
}

export class ProviderInactivityTimeoutError extends Error {
  constructor() {
    super(`Provider request inactive for ${PROVIDER_INACTIVITY_MS} ms.`);
    this.name = 'ProviderInactivityTimeoutError';
  }
}

export async function readBodyTextBestEffort(
  consumption: LlmResponseConsumption,
  response: Response,
): Promise<string> {
  try {
    return await consumption.readText(response);
  } catch (error) {
    if (
      error instanceof ProviderInactivityTimeoutError ||
      error instanceof ProviderRequestDeadlineError ||
      (consumption.signal.aborted &&
        (error === consumption.signal.reason ||
          (error instanceof Error && error.name === 'AbortError')))
    )
      throw error;
    return '';
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
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  const onOwnerAbort = (): void => {
    clear();
    clearTimeout(deadlineTimer);
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
  deadlineTimer = setTimeout(() => {
    if (!active || controller.signal.aborted) return;
    controller.abort(new ProviderRequestDeadlineError());
  }, PROVIDER_REQUEST_DEADLINE_MS);
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
    clearTimeout(deadlineTimer);
    ownerSignal?.removeEventListener('abort', onOwnerAbort);
  }
}
