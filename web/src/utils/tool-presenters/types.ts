export type InlinePart =
  | { kind: 'text'; text: string; language?: 'json' | 'text' }
  | { kind: 'file'; root: 'meta' | 'output'; path: string; label?: string }
  | { kind: 'card'; id: string; fallbackLabel?: string }
  | { kind: 'session'; id: string; label: string }
  | { kind: 'entry'; id: string; label: string };

type ToolTone = 'neutral' | 'ok' | 'error';
interface SemanticField {
  label: string;
  parts: InlinePart[];
}
export interface SemanticSection {
  title: string;
  fields?: SemanticField[];
  content?: string;
  language?: 'json' | 'text';
  items?: SemanticSection[];
  disclosure?: boolean;
}
export interface ToolCallPresentation {
  name: string;
  headline: InlinePart[];
  sections: SemanticSection[];
}
export interface ToolResultPresentation extends ToolCallPresentation {
  status: ToolTone;
  outcome: string;
  target?: InlinePart[];
}
export interface ToolCallMessage {
  name: string;
  args: Record<string, unknown>;
}
export interface ResultPresenterContext {
  name: string;
  envelope: Record<string, unknown>;
  data: unknown;
  dataRecord: Record<string, unknown> | null;
}
interface CallPresenterResult {
  headline: InlinePart[];
  sections: SemanticSection[];
}
export interface ResultPresenterResult {
  headline: InlinePart[];
  sections: SemanticSection[];
  outcome?: string;
  status?: ToolTone;
  target?: InlinePart[];
}
export interface ToolPresenter {
  readonly action: string;
  readonly call: (args: Record<string, unknown>) => CallPresenterResult;
  readonly result: (ctx: ResultPresenterContext) => ResultPresenterResult;
}
