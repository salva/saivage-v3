import { z } from 'zod';

/** GC payload selection, independent of ordinary conversation/model validation. */
export function* rowWorkReferences(value: unknown): Generator<unknown> {
  const { kind } = z.object({ kind: z.string() }).parse(value);
  const row = value as Record<string, unknown>;
  switch (kind) {
    case 'text':
    case 'record_prompt':
    case 'model_repair':
      yield z.string().parse(row.content);
      return;
    case 'tool_call': {
      const call = z
        .object({
          tool_calls: z
            .array(
              z.object({
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .length(1),
        })
        .parse(JSON.parse(z.string().parse(row.content))).tool_calls[0]!.function;
      if (z.string().parse(row.tool) !== call.name)
        throw new Error('Ambiguous GC tool-call owner.');
      const args: unknown = JSON.parse(call.arguments);
      if (call.name === 'run_command') {
        const { command: _command, ...siblings } = z.record(z.unknown()).parse(args);
        yield siblings;
      } else yield args;
      return;
    }
    case 'tool_result': {
      const result = z
        .object({
          success: z.boolean(),
          error: z.unknown(),
          data: z.unknown(),
          content: z.unknown(),
        })
        .parse(JSON.parse(z.string().parse(row.content)));
      if (!result.success) {
        yield z.string().parse(result.error);
        yield result.data;
        return;
      }
      const tool = z.string().parse(row.tool);
      if (tool === 'run_command' || tool === 'wait_process' || tool === 'kill_process') {
        const data = z
          .object({
            status: z.enum(['running', 'exited', 'killed', 'failed']),
            stdout_complete: z.boolean(),
            stderr_complete: z.boolean(),
            stdout: z.string(),
            stderr: z.string(),
          })
          .parse(result.data);
        yield [data.stdout, data.stderr];
        const raw = result.data as Record<string, unknown>;
        if (data.status === 'running' || !data.stdout_complete)
          yield { url: z.string().parse(raw.stdout_url) };
        if (data.status === 'running' || !data.stderr_complete)
          yield { url: z.string().parse(raw.stderr_url) };
      } else {
        yield result.data;
        if (result.content !== undefined)
          for (const value of z.custom<unknown[]>(Array.isArray).parse(result.content)) {
            const block = z
              .object({
                type: z.enum(['text', 'image']),
                text: z.unknown(),
                image: z.unknown(),
              })
              .parse(value);
            yield block.type === 'text' ? z.string().parse(block.text) : block.image;
          }
      }
      return;
    }
    case 'activity':
    case 'record_observation':
    case 'model_issue':
    case 'provider_private':
    case 'model_recovered':
    case 'content_policy_refusal':
    case 'content_policy_retry':
      return;
    default:
      throw new Error('Unknown GC conversation row kind.');
  }
}
