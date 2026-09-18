import { ProcessToolResultSchema, ToolResultSchema, type ProcessToolResult } from '../contracts/index.js';
import { canonicalJson } from '../schemas/index.js';
import { redactTextWithStablePrefixesForOutbound } from '../redaction/index.js';
import { DISCOVERY_RESPONSE_MAX_BYTES } from './response-packer.js';
import { settledSuccessBytes } from './tool-result-settlement.js';

function assertStableHead(head: string, stream: 'stdout' | 'stderr'): void {
  const stable = redactTextWithStablePrefixesForOutbound(head);
  const endpointInsideSpan = stable.indivisibleSpans.some(({ start, end }) => start < head.length && head.length < end);
  if (stable.text !== head || stable.maxPrefixEnd !== head.length || endpointInsideSpan) {
    throw new Error(`Process ${stream} head is not a complete certified outbound projection.`);
  }
}

export function validateProcessToolResult(value: unknown): ProcessToolResult {
  const data = ProcessToolResultSchema.parse(value);
  assertStableHead(data.stdout, 'stdout');
  assertStableHead(data.stderr, 'stderr');

  const bytes = settledSuccessBytes(data);
  if (Buffer.byteLength(bytes, 'utf8') > DISCOVERY_RESPONSE_MAX_BYTES) {
    throw new Error('Process result exceeded the complete successful provider-envelope byte limit.');
  }
  const settled = ToolResultSchema.parse(JSON.parse(bytes));
  if (!settled.success || settled.data === undefined || canonicalJson(settled.data) !== canonicalJson(data)) {
    throw new Error('Process result changed during outbound settlement.');
  }
  return data;
}
