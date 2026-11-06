import { settleToolActionOutcome } from '../contracts/index.js';
import { projectDynamicForOutbound } from '../redaction/index.js';
import type { ToolExecutionResult } from './invocation.js';

/** Safe MCP-shaped projection of transient output; never serialized into a conversation. */
export function projectExternalToolResult(
  execution: ToolExecutionResult<'none' | 'observational_query' | 'canonical_locator'>,
) {
  const settled = settleToolActionOutcome(execution.providerOutcome);
  return {
    result: settled.providerResult,
    content: execution.producedContent
      ? execution.producedContent.blocks.map((block) =>
          block.type === 'text'
            ? { type: 'text' as const, text: projectDynamicForOutbound(block.text) as string }
            : {
                type: 'image' as const,
                mimeType: 'image/png' as const,
                data: block.bytes.toString('base64'),
              },
        )
      : [{ type: 'text' as const, text: settled.settledResultBytes }],
    isError: !settled.providerResult.success,
  };
}
