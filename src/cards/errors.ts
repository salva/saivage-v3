export class CardStoreInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardStoreInvariantError';
  }
}

export class ReorderSetMismatchError extends Error {
  constructor(
    public readonly parentId: string,
    public readonly missing: string[],
    public readonly extra: string[],
  ) {
    super(`Reorder child set mismatch for parent '${parentId}': missing=[${missing.join(',')}], extra=[${extra.join(',')}].`);
    this.name = 'ReorderSetMismatchError';
  }
}
