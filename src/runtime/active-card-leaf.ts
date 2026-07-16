/** Scheduler-only active-leaf projection. It is never passed to persistence. */
export class ActiveCardLeaf {
  #currentCardId: string | null = null;

  constructor(private readonly runtimeProjectionChanged: () => void) {}

  setChain(cardIds: readonly string[]): void {
    if (cardIds.length === 0 || cardIds[0] !== 'project') throw new Error('Active running chain must begin at project.');
    const leaf = cardIds.at(-1)!;
    if (this.#currentCardId === leaf) return;
    this.#currentCardId = leaf;
    this.runtimeProjectionChanged();
  }

  enterChild(parentCardId: string, childCardId: string): void {
    this.assertActive(parentCardId);
    this.#currentCardId = childCardId;
    this.runtimeProjectionChanged();
  }

  resumeParent(childCardId: string, parentCardId: string): void {
    this.assertActive(childCardId);
    this.#currentCardId = parentCardId;
    this.runtimeProjectionChanged();
  }

  activeCardId(): string | null { return this.#currentCardId; }

  assertActive(cardId: string): void {
    if (this.#currentCardId !== cardId) throw new Error(`Card '${cardId}' is not the current autonomous leaf.`);
  }

  clear(): void {
    if (this.#currentCardId === null) throw new Error('Autonomous scheduler has no active leaf to clear.');
    this.#currentCardId = null;
    this.runtimeProjectionChanged();
  }
}
