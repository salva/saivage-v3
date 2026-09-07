import type { CardStatus, RuntimeStatus } from '../../schemas/index.js';
import { canonicalJson } from '../../schemas/index.js';
import { conversationSha256 } from '../../persistence/canonical-conversation-artifacts.js';

const ANALYST_ORIENTATION_KEY = 'analyst.project_tree';
export const ANALYST_ORIENTATION_MAX_BYTES = 8192;
export const ANALYST_ORIENTATION_TITLE_PREVIEW_BYTES = 128;
export const ANALYST_ORIENTATION_OMISSION_MARKER = 'Details omitted from orientation; query get_tree, list_cards, or get_card.';

export interface AnalystOrientationCard {
  readonly id: string;
  readonly parent: string | null;
  readonly type: string;
  readonly status: CardStatus;
  readonly title: string;
  readonly version_seq: number;
  readonly children: readonly string[];
}

export interface AnalystOrientationRuntime {
  readonly status: RuntimeStatus;
  readonly currentCardId: string | null;
}

export interface AnalystOrientationSnapshot {
  readonly content: string;
  readonly fullObservationSha256: string;
  readonly contentSha256: string;
}

export class AnalystOrientationPreparationError extends Error {
  constructor(reason: string) {
    super(`Analyst orientation preparation failed: ${reason}`);
    this.name = 'AnalystOrientationPreparationError';
  }
}

function utf8SafePreview(text: string, maxBytes: number): { content: string; bytes: number; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  let end = Math.min(buffer.length, maxBytes);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { content: buffer.subarray(0, end).toString('utf8'), bytes: end, truncated: end < buffer.length };
}

function countAggregate(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function buildAnalystOrientationSnapshot(
  strictCards: readonly AnalystOrientationCard[],
  runtimeCurrent: AnalystOrientationRuntime,
): AnalystOrientationSnapshot {
  const cards = new Map(strictCards.map((card) => [card.id, card]));
  const root = cards.get('project');
  if (!root) throw new AnalystOrientationPreparationError("the root 'project' card is missing from the strict linked-card projection.");
  for (const card of strictCards) {
    if (card.parent !== null && !cards.has(card.parent)) throw new AnalystOrientationPreparationError(`card '${card.id}' references missing parent '${card.parent}'.`);
  }
  const childOrder = (id: string): readonly string[] => {
    const card = cards.get(id);
    if (!card) throw new AnalystOrientationPreparationError(`linked child '${id}' disappeared during orientation.`);
    return card.children.filter((childId) => cards.has(childId));
  };

  const observationOrder: string[] = [];
  const descendants = new Map<string, number>();
  const containsRunning = new Map<string, boolean>();
  const visit = (id: string): void => {
    observationOrder.push(id);
    let count = 0;
    let running = cards.get(id)!.status === 'running';
    for (const childId of childOrder(id)) {
      visit(childId);
      count += 1 + descendants.get(childId)!;
      running = running || containsRunning.get(childId)!;
    }
    descendants.set(id, count);
    containsRunning.set(id, running);
  };
  visit('project');

  const chain: string[] = [];
  if (root.status === 'running') {
    let current = 'project';
    for (;;) {
      chain.push(current);
      const runningChildren = childOrder(current).filter((childId) => cards.get(childId)!.status === 'running');
      if (runningChildren.length > 1) throw new AnalystOrientationPreparationError(`running card '${current}' has more than one running direct child.`);
      if (runningChildren.length === 0) break;
      current = runningChildren[0]!;
    }
  }
  const chainSet = new Set(chain);
  for (const card of strictCards) {
    if (card.status === 'running' && !chainSet.has(card.id)) throw new AnalystOrientationPreparationError(`running card '${card.id}' lies outside the strict running chain.`);
  }

  const active = runtimeCurrent.currentCardId !== null;
  if (active) {
    if (!cards.has(runtimeCurrent.currentCardId))
      throw new AnalystOrientationPreparationError(`runtime current card '${runtimeCurrent.currentCardId}' is missing from the strict projection.`);
    if (chain.length === 0 || chain.at(-1) !== runtimeCurrent.currentCardId)
      throw new AnalystOrientationPreparationError(`runtime current card '${runtimeCurrent.currentCardId}' disagrees with the strict running chain.`);
  }
  const activePath = active ? [...chain] : [];

  const fullObservation = {
    cards: observationOrder.map((id) => {
      const card = cards.get(id)!;
      return { card_id: id, version_seq: card.version_seq };
    }),
    runtime: { status: runtimeCurrent.status, current_card_id: runtimeCurrent.currentCardId },
  };
  const fullObservationSha256 = conversationSha256(canonicalJson(fullObservation));

  const expanded = new Set<string>(['project', ...chain]);
  const shown = new Set<string>(chain);

  const nodeOf = (id: string): Record<string, unknown> => {
    const card = cards.get(id)!;
    const title = utf8SafePreview(card.title, ANALYST_ORIENTATION_TITLE_PREVIEW_BYTES);
    const node: Record<string, unknown> = {
      id,
      type: card.type,
      status: card.status,
      title: title.content,
      title_bytes: title.bytes,
      title_truncated: title.truncated,
      children_count: childOrder(id).length,
      descendants: descendants.get(id)!,
      contains_running: containsRunning.get(id)!,
    };
    if (expanded.has(id)) {
      const ordered = childOrder(id);
      const shownChildren = ordered.filter((childId) => shown.has(childId));
      if (shownChildren.length > 0) node.children = shownChildren.map((childId) => nodeOf(childId));
      const omittedChildren = ordered.filter((childId) => !shown.has(childId));
      if (omittedChildren.length > 0) {
        node.omitted_children = omittedChildren.length;
        node.omitted_status_counts = countAggregate(omittedChildren.map((childId) => cards.get(childId)!.status));
        node.omitted_type_counts = countAggregate(omittedChildren.map((childId) => cards.get(childId)!.type));
        node.omission_marker = ANALYST_ORIENTATION_OMISSION_MARKER;
      }
    }
    return node;
  };

  const render = (): string => {
    const payload = {
      snapshot: ANALYST_ORIENTATION_KEY,
      runtime: { status: runtimeCurrent.status, current_card: runtimeCurrent.currentCardId },
      active_path: activePath,
      full_observation_sha256: fullObservationSha256,
      root: nodeOf('project'),
    };
    return JSON.stringify(payload);
  };
  const fits = (content: string): boolean => Buffer.byteLength(content, 'utf8') <= ANALYST_ORIENTATION_MAX_BYTES;

  const mandatory = render();
  if (!fits(mandatory)) throw new AnalystOrientationPreparationError(`the mandatory root/active-path skeleton and complete status/type aggregate exceed the ${ANALYST_ORIENTATION_MAX_BYTES}-byte orientation budget.`);

  const candidateParents = [...expanded];
  for (const parentId of candidateParents) {
    for (const childId of childOrder(parentId)) {
      if (shown.has(childId)) continue;
      shown.add(childId);
      if (fits(render())) continue;
      shown.delete(childId);
      break;
    }
  }

  const content = render();
  if (!fits(content)) throw new AnalystOrientationPreparationError(`the rendered orientation exceeds the ${ANALYST_ORIENTATION_MAX_BYTES}-byte budget.`);
  return { content, fullObservationSha256, contentSha256: conversationSha256(content) };
}
