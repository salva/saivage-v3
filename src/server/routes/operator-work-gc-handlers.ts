import { WorkGcBusyError, WORK_GC_BUSY_ERROR } from '../../contracts/index.js';
import type { RuntimeApplication } from '../../application/index.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';

export function buildWorkGcOperatorContractHandlers(application: RuntimeApplication) {
  return defineOperatorContractHandlers({
    'runtime.gcWork': ({ body, request, reply }) => {
      const cancellation = new AbortController();
      const stream = reply.createStream();
      const disconnect = () => {
        if (stream.fatal) return;
        cancellation.abort(new Error('Work GC requester disconnected.'));
      };
      const cleanup = () => {
        request.raw.removeListener('aborted', disconnect);
        reply.raw.removeListener('close', disconnect);
      };
      request.raw.once('aborted', disconnect);
      reply.raw.once('close', disconnect);
      try {
        const completion = application.collectWorkGarbage(
          body,
          cancellation.signal,
          (progress) => stream.optional({ type: 'progress', progress }),
          () => {
            stream.fatal = true;
          },
        );
        // Handle the accepted completion immediately, before deferred inventory starts.
        void completion.then(
          async (response) => {
            if (stream.fatal) return;
            try {
              await stream.finish({ type: 'result', response }, cancellation.signal);
            } catch {
              stream.body.destroy();
            }
            cleanup();
          },
          () => {
            if (stream.fatal) return;
            // A post-header ordinary failure is incomplete, never a JSON fallback.
            stream.body.destroy(new Error('Work GC stream incomplete.'));
            cleanup();
          },
        );
        return { stream: stream.body };
      } catch (error) {
        // Fatal publication uncertainty is handled by the application before this boundary.
        if (error instanceof WorkGcBusyError) {
          cleanup();
          stream.body.destroy();
          return { statusCode: 409, body: WORK_GC_BUSY_ERROR };
        }
        if (!stream.fatal) {
          cleanup();
          stream.body.destroy();
        }
        throw error;
      }
    },
  });
}
