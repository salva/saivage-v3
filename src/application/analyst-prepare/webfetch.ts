import type { AnalystMutationReadContext } from '../../agents/analyst-tool-runner.js';
export interface PreparedFetchedBrief { readonly content: string; readonly metadata: Readonly<Record<string, unknown>>; }

export interface AnalystWebReadClient {
  fetchText(input: { url: string; read_mode?: 'auto' | 'text'; max_bytes?: number }, signal?: AbortSignal): Promise<PreparedFetchedBrief>;
}

export interface AnalystPreparationReadServices {
  readonly web: AnalystWebReadClient;
}

export interface AnalystWebfetchBriefInput {
  readonly url: string;
  readonly read_mode?: 'auto' | 'text';
  readonly max_bytes?: number;
  readonly save_as: string;
}

export function prepareAnalystBriefWebfetch(input: AnalystWebfetchBriefInput, ctx: AnalystMutationReadContext): Promise<PreparedFetchedBrief> {
  return ctx.services.web.fetchText({ url: input.url, read_mode: input.read_mode, max_bytes: input.max_bytes });
}
