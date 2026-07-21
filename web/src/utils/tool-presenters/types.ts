export type InlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'file'; root: 'meta' | 'output'; path: string; label?: string }
  | { kind: 'url'; href: string; label?: string }
  | { kind: 'code'; code: string; language?: string }
  | { kind: 'card'; id: string; fallbackLabel?: string };

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

export interface ToolCallMessage {
  name: string;
  args: Record<string, unknown>;
}

export interface CallPresenterResult {
  icon: string;
  headline: InlinePart[];
  detail?: InlinePart[];
}

export interface ResultPresenterContext {
  name: string;
  envelope: { success: true; data?: unknown };
  data: unknown;
  dataRecord: Record<string, unknown> | null;
  rawContent: string;
}

export interface ResultPresenterResult {
  headline: InlinePart[];
  detail?: InlinePart[];
}

export type CallPresenter = (args: Record<string, unknown>) => CallPresenterResult;
export type ResultPresenter = (ctx: ResultPresenterContext) => ResultPresenterResult;

export interface ToolPresenter {
  readonly action: string;
  readonly group?: 'context' | 'web';
  readonly call: CallPresenter;
  readonly result?: ResultPresenter;
}
