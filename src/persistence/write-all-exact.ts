type ExactWrite = (
  descriptor: number,
  bytes: Uint8Array,
  offset: number,
  length: number,
) => number;

export function writeAllExact(
  descriptor: number,
  bytes: Uint8Array,
  write: ExactWrite,
  zeroProgressError: () => Error,
): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = write(descriptor, bytes, offset, bytes.byteLength - offset);
    if (written === 0) throw zeroProgressError();
    offset += written;
  }
}
