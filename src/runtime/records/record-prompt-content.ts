import { canonicalJson } from '../../schemas/index.js';
import { redactRecordPromptForOutbound } from '../../redaction/index.js';

export const RECORD_PROMPT_BODY_LIMIT_BYTES = 32768;
const DISPLAY_END_BYTES = 8192;

/** Prepare one JSON value for substitution, never parse the opaque redacted display. */
export function prepareRecordPromptContent(body: string | null, currentUrl: string): string {
  if (body === null || Buffer.byteLength(body, 'utf8') <= RECORD_PROMPT_BODY_LIMIT_BYTES)
    return canonicalJson(body);

  const display = redactRecordPromptForOutbound(canonicalJson(body));
  const bytes = Buffer.from(display, 'utf8');
  let head = display;
  let tail = '';
  let omission = 'No further middle elision was needed.';
  if (bytes.length > 2 * DISPLAY_END_BYTES) {
    let headEnd = DISPLAY_END_BYTES;
    while ((bytes[headEnd]! & 0xc0) === 0x80) headEnd--;
    let tailStart = bytes.length - DISPLAY_END_BYTES;
    while ((bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
    head = bytes.subarray(0, headEnd).toString('utf8');
    tail = bytes.subarray(tailStart).toString('utf8');
    omission = `Middle omitted: ${tailStart - headEnd} UTF-8 display bytes.`;
  }
  const notice = `Oversized record preview: the surrounding JSON string contains shortened supplier-encoded/redacted display text, not exact source text. Do not decode its fragments as a record. ${omission} Read the current record: ${currentUrl}. The versionless reference returns latest effective content, which may differ from this preview. This is not a summary or evidence that requirements are absent.`;
  return canonicalJson(`${head}\n\n${notice}\n\n${tail}`);
}
