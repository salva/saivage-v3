import { argKeys, asRecord, oneLine, readToolCallEnvelope, resultName, safeJsonParse, textPart } from './helpers';
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

export function presentToolCall(rawContent: string, fallbackName?: string): ToolCallPresentation {
  const envelope = readToolCallEnvelope(rawContent, fallbackName);
  const argsRecord = asRecord(envelope.args) ?? {};
  const presenter = callPresenters.get(envelope.name);
  if (presenter) {
    const rendered = presenter(argsRecord);
    return { icon: rendered.icon, name: envelope.name, headline: rendered.headline, detail: rendered.detail, body: envelope.args, bodyKind: 'json' };
  }
  const keys = argKeys(argsRecord);
  return {
    icon: '🔧', name: envelope.name,
    headline: textPart(keys ? `(${keys})` : ''), detail: textPart(oneLine(envelope.args, 96)),
    body: envelope.args, bodyKind: 'json',
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

export function registeredToolNamesForTest(): string[] { return [...new Set([...callPresenters.keys(), ...resultPresenters.keys()])].filter((name) => name !== '__default__').sort(); }
export function registeredCallToolNamesForTest(): string[] { return [...callPresenters.keys()].sort(); }
export function registeredResultToolNamesForTest(): string[] { return [...resultPresenters.keys()].sort(); }
