import { PassThrough } from 'node:stream';
import type { z } from 'zod';
import { WORK_GC_FRAME_MAX_BYTES } from '../contracts/index.js';

/** Bounded, lossy optional writes. Terminal transport waits only after owner settlement. */
export class ContractFrameStream {
  readonly body = new PassThrough({ highWaterMark: WORK_GC_FRAME_MAX_BYTES });
  /** Fatal boundary marker: no transport follow-up even when an injected port throws. */
  fatal = false;
  constructor(private readonly schema: z.ZodTypeAny) {
    // Fastify installs its own transport handler on send; early disconnects remain ordinary.
    this.body.on('error', () => undefined);
  }
  private encode(frame: unknown): string {
    const line = `${JSON.stringify(this.schema.parse(frame))}\n`;
    if (Buffer.byteLength(line) > WORK_GC_FRAME_MAX_BYTES)
      throw new Error('Contract stream frame exceeds byte limit.');
    return line;
  }
  optional(frame: unknown): void {
    if (this.body.destroyed || this.body.writableNeedDrain) return;
    this.body.write(this.encode(frame));
  }
  private async drain(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.body.destroyed) throw new Error('Contract stream closed.');
    if (!this.body.writableNeedDrain) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.body.removeListener('drain', drained);
        this.body.removeListener('close', closed);
        this.body.removeListener('error', failed);
        signal.removeEventListener('abort', aborted);
      };
      const drained = () => { cleanup(); resolve(); };
      const failed = (error: unknown) => { cleanup(); reject(error); };
      const closed = () => failed(new Error('Contract stream closed.'));
      const aborted = () => failed(signal.reason);
      this.body.once('drain', drained);
      this.body.once('close', closed);
      this.body.once('error', failed);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
  async finish(frame: unknown, signal: AbortSignal): Promise<void> {
    const line = this.encode(frame);
    await this.drain(signal);
    // false means accepted. It is never sent again.
    this.body.write(line);
    await this.drain(signal);
    this.body.end();
  }
}
