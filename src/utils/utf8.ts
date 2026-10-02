export function utf8SafeSlice(
  text: string,
  offsetBytes: number,
  maxBytes: number,
): { content: string; bytes: number } {
  const buffer = Buffer.from(text, 'utf8');
  if (offsetBytes < 0 || offsetBytes > buffer.length)
    throw new Error('UTF-8 slice offset is outside the observed byte range.');
  let end = Math.min(buffer.length, offsetBytes + maxBytes);
  while (end > offsetBytes && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { content: buffer.subarray(offsetBytes, end).toString('utf8'), bytes: end - offsetBytes };
}
