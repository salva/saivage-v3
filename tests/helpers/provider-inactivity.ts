export function pendingHeaders(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

export function controlledResponse(signal: AbortSignal, status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const abort = () => {
    ended = true;
    controller.error(signal.reason);
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener('abort', abort, { once: true });
    },
    cancel() {
      ended = true;
      signal.removeEventListener('abort', abort);
    },
  });
  return {
    response: new Response(body, { status }),
    send(text: string | Uint8Array) {
      controller.enqueue(typeof text === 'string' ? new TextEncoder().encode(text) : text);
    },
    close() {
      signal.removeEventListener('abort', abort);
      if (ended) return;
      ended = true;
      controller.close();
    },
  };
}
