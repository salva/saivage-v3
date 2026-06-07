import { processApi, type ProcessDetailResponse, type ProcessListResponse, type ProcessView } from '../../runtime/process-api.js';

export type { ProcessControlAvailability, ProcessDetailResponse, ProcessListResponse, ProcessLogRefs, ProcessView } from '../../runtime/process-api.js';

export class ProcessReadModelService {
  constructor(private readonly projectRoot: string) {}

  listProcesses(): ProcessListResponse {
    return processApi(this.projectRoot).listForOperator();
  }

  getProcess(id: string): ProcessDetailResponse | null {
    return processApi(this.projectRoot).getForOperator(id);
  }

  errorMessage(err: unknown): string {
    return processApi(this.projectRoot).errorMessage(err);
  }

  toProcessView(record: Parameters<ReturnType<typeof processApi>['toProcessView']>[0]): ProcessView {
    return processApi(this.projectRoot).toProcessView(record);
  }
}
