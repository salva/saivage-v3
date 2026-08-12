import type { AnalystMutationReadContext } from '../../agents/analyst-tool-runner.js';
import type { WebfetchMetadata } from '../../contracts/webfetch.js';
import type { AnalystPreNetworkAdmission } from '../../contracts/record-mutation.js';
import type { AnalystRecordMutationService } from '../analyst-mutation-services.js';

export interface PreparedFetchedRecord { readonly content: string; readonly metadata: WebfetchMetadata; }

export interface AnalystWebReadClient {
  fetchText(input: { url: string; read_mode?: 'auto' | 'text'; max_bytes?: number }, signal?: AbortSignal): Promise<PreparedFetchedRecord>;
}

export interface AnalystPreparationReadServices {
  readonly web: AnalystWebReadClient;
  readonly records: Pick<AnalystRecordMutationService, 'admitWrite'>;
}

export function admitAnalystRecordWebfetch(input: AnalystWebfetchRecordInput, ctx: AnalystMutationReadContext): AnalystPreNetworkAdmission { return ctx.services.records.admitWrite(input.save_as); }

export interface AnalystWebfetchRecordInput {
  readonly url: string;
  readonly read_mode?: 'auto' | 'text';
  readonly max_bytes?: number;
  readonly save_as: string;
}

export function prepareAnalystRecordWebfetch(input: AnalystWebfetchRecordInput, ctx: AnalystMutationReadContext): Promise<PreparedFetchedRecord> {
  return ctx.services.web.fetchText({ url: input.url, read_mode: input.read_mode, max_bytes: input.max_bytes });
}
