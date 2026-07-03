import type { CardRecord } from '../api/types';

export const ANALYST_SESSION_ID = 'analyst:global';

export interface SyntheticHintState {
  sessionId: string | null;
  content: string | null;
}

export function buildCardContextSeed(card: CardRecord): string {
  const blockers = [
    ...(Array.isArray(card.depends_on) ? card.depends_on.map((id) => `depends_on:${id}`) : []),
    ...(card.lifecycle.error ? [`error:${card.lifecycle.error}`] : []),
  ];
  const toolResult = {
    tool: 'get_card',
    ok: true,
    card: {
      id: card.id,
      title: card.title,
      status: card.status,
      blockers,
      version_seq: card.version_seq ?? null,
    },
  };
  return [
    'System context: this per-card analyst discussion was opened from the card detail view.',
    `Card title: ${card.title}`,
    `Card status: ${card.status}`,
    `Card blockers: ${blockers.length ? blockers.join(', ') : 'none'}`,
    `Tool result get_card: ${JSON.stringify(toolResult)}`,
    'Use this seeded card context as the default subject unless the operator asks otherwise.',
  ].join('\n');
}
