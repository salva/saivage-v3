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
    let written: number;
    try {
      written = write(descriptor, bytes, offset, bytes.byteLength - offset);
    } catch (error) {
      const failure = error as (NodeJS.ErrnoException & { bytesWritten?: number }) | null | undefined;
      if (offset === 0 && failure?.code === 'EINTR' && failure.bytesWritten === 0) continue;
      throw error;
    }
    if (written === 0) throw zeroProgressError();
    offset += written;
  }
}
