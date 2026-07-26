import { ContentPolicyRuntimeResponseSchema, type ContentPolicyRuntimeResponse } from '../../contracts/index.js';
import { readCanonicalLinkedCardHistoryTree } from '../../persistence/card-files.js';
import type { CanonicalReadInstrumentation } from '../../persistence/growing-file.js';

export function buildContentPolicyReadModel(
  projectRoot: string,
  instrumentation?: CanonicalReadInstrumentation,
): ContentPolicyRuntimeResponse {
  const refusals = readCanonicalLinkedCardHistoryTree(projectRoot, instrumentation).flatMap(({ versions }) =>
    versions.flatMap(({ resultingCard, history, version }) => {
      if (history?.kind !== 'terminal' || resultingCard.lifecycle.status !== 'blocked' || resultingCard.lifecycle.result.kind !== 'content-policy-refusal') return [];
      const result = resultingCard.lifecycle.result;
      return [{
        card_id: resultingCard.id,
        session_id: result.session_id,
        marker_id: result.marker_id,
        evidence_url: result.evidence_url,
        blocked_at: history.changed_at,
        version,
      }];
    }),
  );
  refusals.sort((left, right) => left.blocked_at.localeCompare(right.blocked_at) || left.card_id.localeCompare(right.card_id) || left.version - right.version);
  const latest = refusals.at(-1);
  return ContentPolicyRuntimeResponseSchema.parse({
    refusal_high_water: refusals.length,
    latest: latest ? {
      card_id: latest.card_id,
      session_id: latest.session_id,
      marker_id: latest.marker_id,
      evidence_url: latest.evidence_url,
      blocked_at: latest.blocked_at,
    } : null,
  });
}
