export const SSE_DONE = Symbol('sse-done');
type SseEvent = Readonly<{ event: string; dataText: string }>;
export type SseOutput = SseEvent | typeof SSE_DONE;

export class IncrementalSseReader {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #line = '';
  #pendingCR = false;
  #event = '';
  #data: string[] = [];
  #finished = false;

  push(bytes: Uint8Array): SseOutput[] {
    if (this.#finished) throw new Error('Cannot push SSE bytes after finish.');
    return this.#process(this.#decoder.decode(bytes, { stream: true }));
  }

  finish(): SseOutput[] {
    if (this.#finished) throw new Error('Cannot finish SSE reader twice.');
    this.#finished = true;
    const output = this.#process(this.#decoder.decode());
    if (this.#pendingCR) { this.#pendingCR = false; this.#completeLine(output); }
    if (this.#line.length > 0) this.#completeLine(output);
    this.#dispatch(output);
    return output;
  }

  #process(text: string): SseOutput[] {
    const output: SseOutput[] = [];
    for (const character of text) {
      if (this.#pendingCR) {
        this.#pendingCR = false;
        this.#completeLine(output);
        if (character === '\n') continue;
      }
      if (character === '\r') this.#pendingCR = true;
      else if (character === '\n') this.#completeLine(output);
      else this.#line += character;
    }
    return output;
  }

  #completeLine(output: SseOutput[]): void {
    const line = this.#line;
    this.#line = '';
    if (line === '') { this.#dispatch(output); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.#event = value;
    else if (field === 'data') this.#data.push(value);
  }

  #dispatch(output: SseOutput[]): void {
    if (this.#data.length > 0) {
      const dataText = this.#data.join('\n');
      output.push(dataText === '[DONE]' ? SSE_DONE : { event: this.#event || 'message', dataText });
    }
    this.#event = '';
    this.#data = [];
  }
}
