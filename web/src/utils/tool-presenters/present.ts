import { argKeys, asRecord, oneLine, readToolCallMessage, safeJsonParse, textPart } from './helpers';
import { getToolPresenter } from './presenters';
import type { ToolCallPresentation, ToolResultPresentation } from './types';

const RESULT_ICON_OK = '↩';
const RESULT_ICON_ERR = '⚠';
const GENERIC_RESULT_LABEL = 'result unavailable';
const SUCCESS_RESULT_LABEL = 'completed';

export function presentToolCall(rawContent: string): ToolCallPresentation {
  const message = readToolCallMessage(rawContent);
  const descriptor = getToolPresenter(message.name);
  if (descriptor) {
    const rendered = descriptor.call(message.args);
    return { ...rendered, name: message.name, body: message.args, bodyKind: 'json' };
  }
  const keys = argKeys(message.args);
  return { icon: '🔧', name: message.name, headline: textPart(keys ? `(${keys})` : ''), detail: textPart(oneLine(message.args, 96)), body: message.args, bodyKind: 'json' };
}

export function presentToolResult(rawContent: string, opts: { tool?: string } = {}): ToolResultPresentation {
  const name = opts.tool ?? 'tool';
  const parsed = safeJsonParse(rawContent);
  const record = asRecord(parsed);
  if (record?.success === false && typeof record.error === 'string') {
    return { icon: RESULT_ICON_ERR, status: 'error', name, headline: textPart(record.error, 120), body: parsed, bodyKind: 'json' };
  }
  if (record?.success === true && !Object.hasOwn(record, 'error')) {
    const envelope = record as { success: true; data?: unknown };
    const data = envelope.data;
    const rendered = getToolPresenter(name)?.result?.({ name, envelope, data, dataRecord: asRecord(data) });
    const headline = rendered?.headline ?? textPart(SUCCESS_RESULT_LABEL);
    return { icon: RESULT_ICON_OK, status: 'ok', name, headline, detail: rendered?.detail, body: parsed, bodyKind: 'json' };
  }
  return { icon: RESULT_ICON_OK, status: 'ok', name, headline: textPart(GENERIC_RESULT_LABEL), body: parsed ?? rawContent, bodyKind: parsed === null ? 'text' : 'json' };
}
