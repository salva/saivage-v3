import { asRecord, readToolCallMessage, safeJsonParse, textPart, oneLine } from './helpers';
import { getToolPresenter, valueParts } from './presenters';
import type { ToolCallPresentation, ToolResultPresentation } from './types';

export function presentToolCall(rawContent: string): ToolCallPresentation {
  const message = readToolCallMessage(rawContent);
  const descriptor = getToolPresenter(message.name);
  return descriptor
    ? { ...descriptor.call(message.args), name: message.name }
    : { name: message.name, headline: textPart(oneLine(message.args, 48)), sections: [{ title: 'Safe arguments (opaque tool)', content: JSON.stringify(message.args, null, 2), language: 'json' }] };
}

export function presentToolResult(rawContent: string, opts: { tool?: string } = {}): ToolResultPresentation {
  const name = opts.tool ?? 'tool';
  const envelope = asRecord(safeJsonParse(rawContent));
  if (!envelope || typeof envelope.success !== 'boolean' || (envelope.success === false && typeof envelope.error !== 'string') || (envelope.success === true && Object.hasOwn(envelope, 'error'))) {
    return { name, status: 'error', outcome: 'Presentation unavailable', headline: textPart('Unexpected public result shape'), sections: [] };
  }
  const descriptor = getToolPresenter(name);
  const rendered = descriptor?.result({ name, envelope, data: envelope.data, dataRecord: asRecord(envelope.data) });
  if (descriptor && envelope.success === true && name !== 'emit_result' && !asRecord(envelope.data)) {
    return { name, status: 'error', outcome: 'Presentation unavailable', headline: textPart('Expected named public result data'), sections: [] };
  }
  const uncertain = asRecord(envelope.data)?.outcome_unknown === true;
  const failed = envelope.success === false;
  const failureData = asRecord(envelope.data);
  const domainOutcome = rendered?.outcome;
  const outcome = [uncertain ? 'Effects uncertain' : failed ? 'Failed' : '', domainOutcome ?? (!failed && !uncertain ? 'Tool returned success' : ''), failureData?.restart_required === true ? 'Restart required' : ''].filter(Boolean).join(' · ');
  const status = uncertain || failed || rendered?.outcome === 'Presentation unavailable' ? 'error' : rendered?.status ?? 'neutral';
  const refusalFields = failed && failureData ? ['code', 'reason', 'action', 'operation', 'resource', 'owner_id', 'card_id', 'name', 'current_head', 'version', 'from_version', 'to_version', 'side', 'session_id', 'runtime_status', 'restart_required'].flatMap((key) => Object.hasOwn(failureData, key)
    ? [{ label: key.replaceAll('_', ' '), parts: valueParts(failureData[key], false) }] : []) : [];
  const reason = failed ? envelope.error || failureData?.reason || failureData?.code : null;
  const sections = rendered?.sections ?? (Object.hasOwn(envelope, 'data') ? [{ title: 'Safe result (opaque tool)', content: JSON.stringify(envelope.data, null, 2), language: 'json' as const }] : []);
  if (failed) sections.unshift({ title: uncertain ? 'Uncertainty' : 'Error', content: String(envelope.error) });
  if (refusalFields.length) sections.push({ title: 'Recorded refusal / error context', fields: refusalFields });
  if (envelope.image !== undefined) sections.push({ title: 'Typed image descriptor (metadata only)', content: JSON.stringify(envelope.image, null, 2), language: 'json', disclosure: true });
  return { name, status, outcome, headline: reason ? textPart(oneLine(reason, 56)) : rendered?.headline ?? [], sections, target: rendered?.target };
}
