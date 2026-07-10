import { argKeys, asRecord, oneLine, readToolCallMessage, resultName, safeJsonParse, textPart } from './helpers';
import type { CallPresenter, ResultPresenter, ToolCallPresentation, ToolPresenterRegistration, ToolResultPresentation } from './types';

const RESULT_ICON_OK = '↩';
const RESULT_ICON_ERR = '⚠';
const callPresenters = new Map<string, CallPresenter>();
const resultPresenters = new Map<string, ResultPresenter>();
let defaultRegistrationLoaded = false;

export function registerToolPresenter(registration: ToolPresenterRegistration): void {
  if (registration.name === '__default__') defaultRegistrationLoaded = true;
  if (registration.call) callPresenters.set(registration.name, registration.call);
  if (registration.result) resultPresenters.set(registration.name, registration.result);
}

export function assertDefault(): void {
  if (!defaultRegistrationLoaded) throw new Error('tool presenter default registration was not loaded');
}

export function presentToolCall(rawContent: string): ToolCallPresentation {
  const message = readToolCallMessage(rawContent);
  const presenter = callPresenters.get(message.name);
  if (presenter) {
    const rendered = presenter(message.args);
    return { icon: rendered.icon, name: message.name, headline: rendered.headline, detail: rendered.detail, body: message.args, bodyKind: 'json' };
  }
  const keys = argKeys(message.args);
  return {
    icon: '🔧', name: message.name,
    headline: textPart(keys ? `(${keys})` : ''), detail: textPart(oneLine(message.args, 96)),
    body: message.args, bodyKind: 'json',
  };
}

export function presentToolResult(rawContent: string, opts: { tool?: string; kind?: string } = {}): ToolResultPresentation {
  const name = resultName(rawContent, opts.tool);
  const parsed = safeJsonParse(rawContent);
  const record = asRecord(parsed);
  const isError = opts.kind === 'tool_error' || record?.ok === false || typeof record?.error === 'string';
  const status = isError ? 'error' : 'ok';
  if (status === 'error') {
    const message = record?.error ?? record?.message ?? parsed ?? rawContent;
    return { icon: RESULT_ICON_ERR, status, name, headline: textPart(message, 120), body: parsed ?? rawContent, bodyKind: parsed === null ? 'text' : 'json' };
  }
  const ctx = { name, status, parsed, record, rawContent } as const;
  const presenter = resultPresenters.get(name);
  if (presenter) {
    const rendered = presenter(ctx);
    return { icon: RESULT_ICON_OK, status, name, headline: rendered.headline, detail: rendered.detail, body: parsed ?? rawContent, bodyKind: parsed === null ? 'text' : 'json' };
  }
  const summary = record?.summary ?? record?.message ?? record?.content ?? parsed ?? rawContent;
  return { icon: RESULT_ICON_OK, status, name, headline: textPart(summary, 120), body: parsed ?? rawContent, bodyKind: parsed === null ? 'text' : 'json' };
}
