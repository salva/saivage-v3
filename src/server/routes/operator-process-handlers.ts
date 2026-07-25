import { buildProcessView } from '../../application/read-models/process-view.js';
import { defineOperatorContractHandlers, type OperatorProjectContext } from './operator-handler-context.js';
import type { ProcessRunner } from '../../runtime/process-runner.js';

type ProcessOperatorHandlerOptions = OperatorProjectContext & { processRunner: ProcessRunner };

export function buildProcessOperatorContractHandlers(options: ProcessOperatorHandlerOptions) {
  const processRunner = options.processRunner;

  return defineOperatorContractHandlers({
    'processes.list': () => ({ body: { processes: processRunner.list().map((record) => buildProcessView(options.projectRoot, record)) } }),
  });
}
