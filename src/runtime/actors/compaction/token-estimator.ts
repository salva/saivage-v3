export function estimateUtf8Tokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}
