import { ContentPolicyRuntimeResponseSchema, type ContentPolicyRuntimeResponse } from '../../contracts/index.js';
import { readCanonicalLinkedCardHistoryTree } from '../../persistence/card-files.js';
import type { CanonicalReadInstrumentation } from '../../persistence/growing-file.js';

export function buildContentPolicyReadModel(
  projectRoot: string,
  instrumentation?: CanonicalReadInstrumentation,
): ContentPolicyRuntimeResponse {
  const refusals = readCanonicalLinkedCardHistoryTree(projectRoot, instrumentation).flatMap(({ versions }) =>
    versions.flatMap(({ change, version }) => {
      const policy = change?.terminal_summary?.content_policy;
      if (!policy) return [];
      return [{
        card_id: change.card_id,
        session_id: policy.session_id,
        marker_id: policy.marker_id,
        evidence_url: policy.evidence_url,
        blocked_at: policy.blocked_at,
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
