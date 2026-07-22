import type { AnalystMutationReadContext } from '../../agents/analyst-tool-runner.js';
import type { WebfetchMetadata } from '../../contracts/webfetch.js';

export interface PreparedFetchedRecord { readonly content: string; readonly metadata: WebfetchMetadata; }

export interface AnalystWebReadClient {
  fetchText(input: { url: string; read_mode?: 'auto' | 'text'; max_bytes?: number }, signal?: AbortSignal): Promise<PreparedFetchedRecord>;
}

export interface AnalystPreparationReadServices {
  readonly web: AnalystWebReadClient;
}

export interface AnalystWebfetchRecordInput {
  readonly url: string;
  readonly read_mode?: 'auto' | 'text';
  readonly max_bytes?: number;
  readonly save_as: string;
}

export function prepareAnalystRecordWebfetch(input: AnalystWebfetchRecordInput, ctx: AnalystMutationReadContext): Promise<PreparedFetchedRecord> {
  return ctx.services.web.fetchText({ url: input.url, read_mode: input.read_mode, max_bytes: input.max_bytes });
}
