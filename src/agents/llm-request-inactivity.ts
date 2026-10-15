import {
  LlmRequestError,
  PublicationOutcomeUnknownError,
  throwIfPublicationOutcomeUnknown,
  type LlmResponseConsumption,
  type OutboundHttpObservation,
} from '../contracts/index.js';
import { beginOutboundHttp } from '../observability/index.js';

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
    throwIfPublicationOutcomeUnknown(error);
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
  observation?: OutboundHttpObservation,
): Promise<T> {
  ownerSignal?.throwIfAborted();
  const controller = new AbortController();
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let http: ReturnType<typeof beginOutboundHttp> | undefined;
  let responseOk: boolean | undefined;
  let publicationUnknown = false;
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
    onBodyDisposition: (disposition) => http?.body(disposition),
    signal: controller.signal,
    onData,
    async readText(response) {
      if (!response.body) {
        http?.body('not_consumed');
        return '';
      }
      const reader = response.body.getReader();
      http?.body('incomplete');
      const decoder = new TextDecoder();
      let text = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            http?.body('consumed');
            return text + decoder.decode();
          }
          if (value.byteLength > 0) onData();
          text += decoder.decode(value, { stream: true });
        }
      } catch (error) {
        publicationUnknown = error instanceof PublicationOutcomeUnknownError;
        throwIfPublicationOutcomeUnknown(error);
        throw error;
      } finally {
        if (!publicationUnknown) reader.releaseLock();
      }
    },
  };
  ownerSignal?.addEventListener('abort', onOwnerAbort, { once: true });
  onData();
  const deadlineTimer = setTimeout(() => {
    if (!active || controller.signal.aborted) return;
    controller.abort(new ProviderRequestDeadlineError());
  }, PROVIDER_REQUEST_DEADLINE_MS);
  const terminal: NonNullable<typeof http>['terminal'] = (outcome, code) => {
    try {
      http?.terminal(outcome, code);
    } catch (error) {
      publicationUnknown = error instanceof PublicationOutcomeUnknownError;
      throw error;
    }
  };
  try {
    http = observation ? beginOutboundHttp(observation) : undefined;
    const response = await fetch(input, { ...init, signal: controller.signal });
    responseOk = response.ok;
    http?.headers(response);
    http?.body('not_consumed');
    const result = await consume(response, context);
    terminal(response.ok ? 'completed' : 'http_error', response.ok ? 'none' : 'http_status');
    return result;
  } catch (error) {
    publicationUnknown = error instanceof PublicationOutcomeUnknownError;
    throwIfPublicationOutcomeUnknown(error);
    // Fetch body readers may surface AbortError rather than the supplied reason.
    // Only abort-associated outcomes belong to this scope; native failures keep authority.
    if (
      controller.signal.aborted &&
      (error === controller.signal.reason ||
        (error instanceof Error && error.name === 'AbortError'))
    ) {
      const reason = ownerSignal?.aborted ? ownerSignal.reason : controller.signal.reason;
      http?.body('incomplete');
      terminal(
        ownerSignal?.aborted ? 'cancelled' : 'timeout',
        ownerSignal?.aborted
          ? 'owner_abort'
          : reason instanceof ProviderInactivityTimeoutError
            ? 'inactivity'
            : 'deadline',
      );
      throw reason;
    }
    terminal(
      responseOk === false ? 'http_error' : 'failed',
      responseOk === false
        ? 'http_status'
        : error instanceof LlmRequestError
          ? error.failure.kind === 'parse_error'
            ? 'protocol'
            : 'provider_failure'
          : responseOk === undefined
            ? 'network'
            : 'protocol',
    );
    throw error;
  } finally {
    if (!publicationUnknown) {
      active = false;
      clear();
      clearTimeout(deadlineTimer);
      ownerSignal?.removeEventListener('abort', onOwnerAbort);
    }
  }
}
