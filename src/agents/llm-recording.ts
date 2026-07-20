const STREAM_TEE_MAX_BYTES = 16 * 1024 * 1024;

export function teeStreamForRecorder(body: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  getBuffer: () => string;
} {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buf = '';
  let truncated = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!truncated) {
            const text = decoder.decode(value, { stream: true });
            if (buf.length + text.length > STREAM_TEE_MAX_BYTES) {
              const remaining = Math.max(0, STREAM_TEE_MAX_BYTES - buf.length);
              buf += text.slice(0, remaining) + '\n[truncated at 16 MiB]\n';
              truncated = true;
            } else {
              buf += text;
            }
          }
          controller.enqueue(value);
        }
        if (!truncated) buf += decoder.decode();
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* noop */
        }
      }
    },
  });

  return { stream, getBuffer: () => buf };
}
