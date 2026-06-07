import type { InlinePart } from '../../utils/tool-presenters';

export function callEnvelope(name: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ role: 'assistant', tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
}

export function inlineText(parts: InlinePart[] | undefined): string {
  return (parts ?? []).map((part) => {
    if (part.kind === 'text') return part.text;
    if (part.kind === 'file') return part.label ?? part.path;
    if (part.kind === 'url') return part.label ?? part.href;
    if (part.kind === 'card') return part.fallbackLabel ?? part.id;
    return part.code;
  }).join('');
}
