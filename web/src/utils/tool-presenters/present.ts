import { argKeys, asRecord, oneLine, readToolCallMessage, resultName, safeJsonParse, textPart } from './helpers';
import { getToolPresenter } from './presenters';
import type { ToolCallPresentation, ToolResultPresentation } from './types';

const RESULT_ICON_OK = '↩';
const RESULT_ICON_ERR = '⚠';

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
  const name = resultName(rawContent, opts.tool);
  const parsed = safeJsonParse(rawContent);
  const record = asRecord(parsed);
  if (record?.success === false || typeof record?.error === 'string') {
    return { icon: RESULT_ICON_ERR, status: 'error', name, headline: textPart(record.error ?? rawContent, 120), body: parsed ?? rawContent, bodyKind: parsed === null ? 'text' : 'json' };
  }
  const descriptor = getToolPresenter(name);
  if (record?.success === true) {
    const envelope = record as { success: true; data?: unknown };
    const hasData = Object.hasOwn(record, 'data');
    const data = envelope.data;
    const rendered = descriptor?.result?.({ name, envelope, data, dataRecord: asRecord(data), rawContent });
    const headline = hasData ? (rendered?.headline ?? textPart(data, 120)) : textPart('success');
    return { icon: RESULT_ICON_OK, status: 'ok', name, headline, detail: rendered?.detail, body: parsed, bodyKind: 'json' };
  }
  return { icon: RESULT_ICON_OK, status: 'ok', name, headline: textPart(parsed ?? rawContent, 120), body: parsed ?? rawContent, bodyKind: parsed === null ? 'text' : 'json' };
}
