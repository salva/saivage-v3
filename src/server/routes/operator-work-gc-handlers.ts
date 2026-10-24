import { WorkGcBusyError, WORK_GC_BUSY_ERROR } from '../../contracts/index.js';
import type { RuntimeApplication } from '../../application/index.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';

export function buildWorkGcOperatorContractHandlers(application: RuntimeApplication) {
  return defineOperatorContractHandlers({
    'runtime.gcWork': async ({ body, request, reply }) => {
      const cancellation = new AbortController();
      let settled = false;
      const disconnect = () => {
        if (!settled) cancellation.abort(new Error('Work GC requester disconnected.'));
      };
      request.raw.once('aborted', disconnect);
      reply.raw.once('close', disconnect);
      try {
        const result = await application.collectWorkGarbage(body, cancellation.signal);
        settled = true;
        return { body: result };
      } catch (error) {
        // Fatal publication uncertainty is handled by the application before this boundary.
        if (error instanceof WorkGcBusyError) {
          settled = true;
          return { statusCode: 409, body: WORK_GC_BUSY_ERROR };
        }
        throw error;
      }
    },
  });
}
