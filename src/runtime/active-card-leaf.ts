/** Scheduler-only active-leaf projection. It is never passed to persistence. */
export class ActiveCardLeaf {
  #currentCardId: string | null = null;

  startRoot(cardId: string): void {
    if (this.#currentCardId !== null) throw new Error('Autonomous scheduler already has an active leaf.');
    this.#currentCardId = cardId;
  }

  enterChild(parentCardId: string, childCardId: string): void {
    this.assertActive(parentCardId);
    this.#currentCardId = childCardId;
  }

  resumeParent(childCardId: string, parentCardId: string): void {
    this.assertActive(childCardId);
    this.#currentCardId = parentCardId;
  }

  activeCardId(): string | null { return this.#currentCardId; }

  assertActive(cardId: string): void {
    if (this.#currentCardId !== cardId) throw new Error(`Card '${cardId}' is not the current autonomous leaf.`);
  }

  clear(): void { this.#currentCardId = null; }
}
