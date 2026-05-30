import type { LlmCompleteResult, ToolCall } from './llm-contracts.js';
import { LlmRequestError } from './llm-errors.js';

export async function readOpenAIChatStream(body: ReadableStream<Uint8Array>): Promise<LlmCompleteResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const contentChunks: string[] = [];
  let buffer = '';
  let finishReason: 'stop' | 'tool_calls' | 'length' | null = null;
  const toolCallAccumulators: Map<number, { id?: string; type?: string; name?: string; arguments: string }> = new Map();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        readOpenAIChatStreamLine(line, contentChunks, toolCallAccumulators, (reason) => { finishReason = reason; });
        if (line.trim() === 'data: [DONE]') {
          return buildOpenAIChatStreamResult(contentChunks, toolCallAccumulators, finishReason);
        }
      }
    }

    if (buffer.trim()) {
      readOpenAIChatStreamLine(buffer, contentChunks, toolCallAccumulators, (reason) => { finishReason = reason; });
    }

    return buildOpenAIChatStreamResult(contentChunks, toolCallAccumulators, finishReason);
  } catch (err) {
    if (err instanceof LlmRequestError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new LlmRequestError({ kind: 'cancelled', provider: 'unknown', reason: 'timeout', message: 'Streaming LLM request aborted due to timeout' });
    }
    throw new LlmRequestError({ kind: 'parse_error', provider: 'unknown', message: `Error reading LLM stream: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    reader.releaseLock();
  }
}

function readOpenAIChatStreamLine(
  line: string,
  contentChunks: string[],
  toolCallAccumulators: Map<number, { id?: string; type?: string; name?: string; arguments: string }>,
  setFinishReason: (reason: 'stop' | 'tool_calls' | 'length') => void,
): void {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data: ')) return;
  const data = trimmed.slice(6).trim();
  if (data === '[DONE]') return;

  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{
            index: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
    };
    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) setFinishReason(choice.finish_reason as 'stop' | 'tool_calls' | 'length');
    const delta = choice.delta;
    if (!delta) return;
    if (delta.content) contentChunks.push(delta.content);
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index;
        let acc = toolCallAccumulators.get(index);
        if (!acc) {
          acc = { arguments: '' };
          toolCallAccumulators.set(index, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.type) acc.type = tc.type;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
      }
    }
  } catch {
    // Skip unparseable lines — could be comments or keepalives.
  }
}

export function buildOpenAIChatStreamResult(
  contentChunks: string[],
  toolCallAccumulators: Map<number, { id?: string; type?: string; name?: string; arguments: string }>,
  _finishReason: 'stop' | 'tool_calls' | 'length' | null,
): LlmCompleteResult {
  const toolCalls: ToolCall[] = [];
  const sortedIndices = [...toolCallAccumulators.keys()].sort((a, b) => a - b);
  for (const index of sortedIndices) {
    const acc = toolCallAccumulators.get(index)!;
    toolCalls.push({
      id: acc.id ?? `call_${index}`,
      type: (acc.type as 'function') ?? 'function',
      function: {
        name: acc.name ?? '',
        arguments: acc.arguments,
      },
    });
  }
  if (toolCalls.length > 0) return { kind: 'tool_calls', tool_calls: toolCalls };
  return { kind: 'message', content: contentChunks.join('') };
}
