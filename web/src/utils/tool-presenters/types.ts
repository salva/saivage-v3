export type InlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'file'; root: 'meta' | 'output'; path: string; label?: string }
  | { kind: 'url'; href: string; label?: string }
  | { kind: 'code'; code: string; language?: string };

export type ToolStatus = 'ok' | 'error';

export interface ToolCallPresentation {
  icon: string;
  name: string;
  headline: InlinePart[];
  detail?: InlinePart[];
  body: unknown;
  bodyKind: 'json' | 'markdown' | 'text';
}

export interface ToolResultPresentation {
  icon: string;
  status: ToolStatus;
  name: string;
  headline: InlinePart[];
  detail?: InlinePart[];
  body: unknown;
  bodyKind: 'json' | 'markdown' | 'text';
}

export interface ToolCallEnvelope {
  name: string;
  args: unknown;
}

export interface CallPresenterResult {
  icon: string;
  headline: InlinePart[];
  detail?: InlinePart[];
}

export interface ResultPresenterContext {
  name: string;
  status: ToolStatus;
  parsed: unknown;
  record: Record<string, unknown> | null;
  rawContent: string;
}

export interface ResultPresenterResult {
  headline: InlinePart[];
  detail?: InlinePart[];
}

export type CallPresenter = (args: Record<string, unknown>) => CallPresenterResult;
export type ResultPresenter = (ctx: ResultPresenterContext) => ResultPresenterResult;

export interface ToolPresenterRegistration {
  name: string;
  call?: CallPresenter;
  result?: ResultPresenter;
}
