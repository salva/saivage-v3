import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import { McpToolInvocationNotInstalledError } from '../mcp/tool-invocation-installation.js';
import { defineToolBinder, executedToolOutcome, MCP_RESULT_POLICY_TEMPLATE, type ToolBinder, type ToolExecutionResult } from './invocation.js';
import { toolFailed, toolSucceeded } from '../contracts/tool-result.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import { McpToolCallArgumentsSchema } from '../contracts/mcp-invocation.js';
import { DISCOVERY_RESPONSE_MAX_BYTES } from '../contracts/builtin-tool-inputs.js';
import { canonicalJson } from '../schemas/index.js';
import { projectDynamicForOutbound } from '../redaction/dynamic.js';
import { redactTextWithStablePrefixesForOutbound } from '../redaction/text.js';
import { settledSuccessBytes } from './tool-result-settlement.js';

const MCP_ERROR_MAX_BYTES = 512;

interface StableTextProjection {
  readonly text: string;
  readonly maxPrefixEnd: number;
  readonly indivisibleSpans: readonly { start: number; end: number }[];
}

function certifiedPrefixEndpoints(stable: StableTextProjection, maximumEnd: number, maximumBytes: number): number[] {
  const endpoints = [0];
  let end = 0;
  let bytes = 0;
  let spanIndex = 0;
  for (const character of stable.text) {
    end += character.length;
    bytes += Buffer.byteLength(character, 'utf8');
    while (stable.indivisibleSpans[spanIndex] && stable.indivisibleSpans[spanIndex]!.end <= end) spanIndex += 1;
    const span = stable.indivisibleSpans[spanIndex];
    const insideSpan = span !== undefined && span.start < end && end < span.end;
    if (end <= stable.maxPrefixEnd && end <= maximumEnd && bytes <= maximumBytes && !insideSpan) endpoints.push(end);
  }
  return endpoints;
}

function commonPrefixEnd(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let end = 0;
  while (end < limit && left[end] === right[end]) end += 1;
  return end;
}

function packMcpSuccess(value: unknown): { result: unknown; result_complete: boolean; result_utf8_bytes: number } {
  const projected = projectDynamicForOutbound(value);
  const text = canonicalJson(projected);
  const resultUtf8Bytes = Buffer.byteLength(text, 'utf8');
  const complete = { result: value, result_complete: true, result_utf8_bytes: resultUtf8Bytes };
  if (Buffer.byteLength(settledSuccessBytes(complete), 'utf8') <= DISCOVERY_RESPONSE_MAX_BYTES) return complete;

  const stable = redactTextWithStablePrefixesForOutbound(text);
  const endpoints = certifiedPrefixEndpoints(stable, commonPrefixEnd(text, stable.text), DISCOVERY_RESPONSE_MAX_BYTES);
  const candidate = (index: number) => ({ result: text.slice(0, endpoints[index]!), result_complete: false, result_utf8_bytes: resultUtf8Bytes });
  if (Buffer.byteLength(settledSuccessBytes(candidate(0)), 'utf8') > DISCOVERY_RESPONSE_MAX_BYTES) {
    throw new Error('MCP result metadata exceeded the complete-result byte limit.');
  }
  let low = 0;
  let high = endpoints.length - 1;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    if (Buffer.byteLength(settledSuccessBytes(candidate(middle)), 'utf8') <= DISCOVERY_RESPONSE_MAX_BYTES) low = middle;
    else high = middle - 1;
  }
  return candidate(low);
}

function boundedMcpError(message: string): string {
  const stable = redactTextWithStablePrefixesForOutbound(message);
  const endpoints = certifiedPrefixEndpoints(stable, stable.text.length, MCP_ERROR_MAX_BYTES);
  return stable.text.slice(0, endpoints.at(-1)!);
}

export interface McpProviderContext {
  readonly mcpToolInvocation: McpToolInvocationPort;
}

export const mcpToolBinders: readonly ToolBinder<McpProviderContext, any>[] = Object.freeze([
  defineToolBinder({
    name: 'mcp_tool_call',
    description: 'Call an MCP tool on a configured MCP server. Success data is {result,result_complete,result_utf8_bytes} within a fixed 32,768-byte complete settled envelope. result_utf8_bytes counts the complete outbound-projected canonical JSON source. An incomplete result is a lossy, projection-stable exact UTF-8 prefix of that source, may be shorter or empty, and has no continuation or artifact.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpToolCallArgumentsSchema,
    executor: async (ctx, args): Promise<ToolExecutionResult<'none'>> => {
      let value: unknown;
      try {
        value = await ctx.mcpToolInvocation.invokeTool(args.serverName, args.toolName, args.args ?? {});
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (error instanceof McpToolInvocationNotInstalledError) throw error;
        return executedToolOutcome('none', toolFailed(boundedMcpError(error instanceof Error ? error.message : String(error))));
      }
      return executedToolOutcome('none', toolSucceeded(packMcpSuccess(value)));
    },
  }),
]);
