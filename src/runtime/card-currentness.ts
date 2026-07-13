import { RootCurrentness, isAuthorityCurrent, type RootLeafAuthority } from '../application/mutation-authority.js';

export interface CardMutationAuthority {
  readonly cardId: string;
  current(): RootLeafAuthority;
}

export class AutonomousCardCurrentness {
  readonly #identities = new RootCurrentness();
  #currentCardId: string | null = null;
  #currentAuthority: RootLeafAuthority | null = null;

  startRoot(cardId: string): CardMutationAuthority {
    if (this.#currentAuthority !== null) throw new Error('Autonomous card currentness already has an active leaf.');
    const root = this.#identities.installRoot();
    this.#currentCardId = cardId;
    this.#currentAuthority = this.#identities.installLeaf(root);
    return this.forCard(cardId);
  }

  enterChild(parentCardId: string, childCardId: string): CardMutationAuthority {
    this.requireCurrent(parentCardId);
    const root = this.#identities.currentRoot();
    if (root === null) throw new Error('Autonomous root authority is absent.');
    this.#currentCardId = childCardId;
    this.#currentAuthority = this.#identities.installLeaf(root);
    return this.forCard(childCardId);
  }

  resumeParent(childCardId: string, parentCardId: string): void {
    this.requireCurrent(childCardId);
    const root = this.#identities.currentRoot();
    if (root === null) throw new Error('Autonomous root authority is absent.');
    this.#currentCardId = parentCardId;
    this.#currentAuthority = this.#identities.installLeaf(root);
  }

  forCard(cardId: string): CardMutationAuthority {
    return Object.freeze({ cardId, current: () => this.requireCurrent(cardId) });
  }

  clear(): void {
    this.#currentCardId = null;
    this.#currentAuthority = null;
    this.#identities.clearRoot();
  }

  private requireCurrent(cardId: string): RootLeafAuthority {
    const authority = this.#currentAuthority;
    if (this.#currentCardId !== cardId || authority === null || !isAuthorityCurrent(authority)) {
      throw new Error(`Card '${cardId}' does not own the current autonomous leaf authority.`);
    }
    return authority;
  }
}
