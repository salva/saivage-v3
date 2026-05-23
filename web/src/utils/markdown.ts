export type MarkdownSegment =
  | { kind: 'text'; content: string }
  | { kind: 'code'; content: string; language?: string }
  | { kind: 'inline-code'; content: string };

const FENCE_RE = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/g;
const INLINE_RE = /`([^`\r\n]+)`/g;

/**
 * Split a markdown-like string into typed segments: fenced code blocks
 * (```lang\n...```), inline code (`...`) and plain text. Adjacent text is
 * coalesced into a single `text` segment. No parsing of other markdown is
 * attempted — this is solely a code-fence splitter for the operator UI.
 */
export function splitMarkdownSegments(input: string): MarkdownSegment[] {
  if (typeof input !== 'string' || input.length === 0) return [];

  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(input)) !== null) {
    const start = match.index;
    if (start > cursor) {
      pushText(segments, input.slice(cursor, start));
    }
    const language = match[1] ? match[1] : undefined;
    segments.push({ kind: 'code', content: match[2], language });
    cursor = FENCE_RE.lastIndex;
  }
  if (cursor < input.length) {
    pushText(segments, input.slice(cursor));
  }
  return segments;
}

function pushText(segments: MarkdownSegment[], text: string): void {
  if (text.length === 0) return;
  // Split inline backtick code out of the text run.
  let cursor = 0;
  let match: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(text)) !== null) {
    const start = match.index;
    if (start > cursor) {
      appendText(segments, text.slice(cursor, start));
    }
    segments.push({ kind: 'inline-code', content: match[1] });
    cursor = INLINE_RE.lastIndex;
  }
  if (cursor < text.length) {
    appendText(segments, text.slice(cursor));
  }
}

function appendText(segments: MarkdownSegment[], text: string): void {
  if (text.length === 0) return;
  const last = segments[segments.length - 1];
  if (last && last.kind === 'text') {
    last.content += text;
    return;
  }
  segments.push({ kind: 'text', content: text });
}
