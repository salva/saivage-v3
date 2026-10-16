import { randomUUID } from 'node:crypto';
import type { CardService } from '../../cards/store-api.js';
import type { CardRecord } from '../../schemas/index.js';
import { agentMessageSchema, canonicalJson, STRUCTURAL_ROW_POLICY } from '../../schemas/index.js';
import {
  publicRecordSelection,
  recordObservationKey,
  sameRecordSelection,
} from '../../schemas/index.js';
import { renderCompiledPrompt } from '../../utils/prompt-api.js';
import { observeRecordProjection } from '../../persistence/index.js';
import { generateRoundId } from '../../schemas/round-id-server.js';
import type { RecordContextSupplier } from '../actors/llm-invocation.js';
import type { CompiledNodeContract } from '../card-process/card-process-config.js';
import {
  prepareRecordPromptContent,
  RECORD_PROMPT_BODY_LIMIT_BYTES,
} from './record-prompt-content.js';

/** One owning current read per newly armed logical operation; no retained body cache. */
export function bootstrapContextSupplier(
  store: Pick<CardService, 'readRecordCurrent' | 'workflows'>,
  card: CardRecord,
  node: Pick<CompiledNodeContract, 'nodeId' | 'recordPrompts'>,
): RecordContextSupplier {
  const workflow = store.workflows.cardTypes.get(card.type);
  if (!workflow) throw new Error(`No workflow is configured for card type '${card.type}'.`);
  const recordName = workflow.bootstrapRecord.name;
  const nodeId = node.nodeId;
  return ({ inputId, conversation }) => {
    const projections = new Map(
      [...new Set([recordName, ...node.recordPrompts.map((input) => input.record)])].map((name) => {
        const result = store.readRecordCurrent(card.id, name);
        if (result.kind === 'card-not-found') throw new Error(`Card '${card.id}' is unavailable.`);
        return [name, result.value.projection] as const;
      }),
    );
    const projection = projections.get(recordName);
    if (!projection) throw new Error(`Bootstrap record '${card.id}/${recordName}' is unavailable.`);
    const accepted = projection.accepted;
    if (!accepted)
      throw new Error(`Bootstrap record '${card.id}/${recordName}' has no accepted content.`);
    const observed = observeRecordProjection({
      cardId: card.id,
      recordName,
      projection,
      view: 'accepted',
      selectionKind: 'current',
      exposure: { kind: 'full_body' },
    });
    const latest = conversation.effectiveRequiredModelFacts.latestRecordObservations.find(
      (entry) =>
        recordObservationKey(entry.observation.observed) === recordObservationKey(observed),
    );
    const preparedRows =
      latest && canonicalJson(latest.observation.observed) === canonicalJson(observed)
        ? []
        : [
            agentMessageSchema.parse({
              id: `${conversation.sourceSessionId}:record-observation:${randomUUID()}`,
              session_id: conversation.sourceSessionId,
              role: 'system',
              kind: 'record_observation',
              content: '',
              context_policy: STRUCTURAL_ROW_POLICY.record_observation,
              record_observations: [
                { observed, source: { kind: 'preparation', input_id: inputId, node_id: nodeId } },
              ],
              round_id: generateRoundId('pre'),
              message_index: 0,
              block_index: 0,
              timestamp: new Date().toISOString(),
            }),
          ];
    const rows = [];
    for (const input of node.recordPrompts) {
      const selected = projections.get(input.record)!;
      const body =
        input.selection === 'accepted'
          ? selected?.accepted?.content
          : (selected?.draft?.content ?? selected?.accepted?.content);
      if (body === undefined && input.presence === 'required')
        throw new Error(
          `Required ${input.selection} record '${card.id}/${input.record}' has no selected content.`,
        );
      const includesBody = input.artifact.compiled.tokens.some(
        (token) => token.kind === 'placeholder' && token.key === 'recordContent',
      );
      const oversized =
        body !== undefined && Buffer.byteLength(body, 'utf8') > RECORD_PROMPT_BODY_LIMIT_BYTES;
      const current = observeRecordProjection({
        cardId: card.id,
        recordName: input.record,
        projection: selected ?? null,
        view: input.selection,
        selectionKind: 'current',
        exposure: { kind: includesBody ? (oversized ? 'excerpt' : 'full_body') : 'reference_only' },
      });
      const prior = conversation.effectiveRequiredModelFacts.latestRecordObservations.find(
        (entry) =>
          recordObservationKey(entry.observation.observed) === recordObservationKey(current),
      );
      if (prior && sameRecordSelection(prior.observation.observed, current)) {
        const metadata = observeRecordProjection({
          cardId: card.id,
          recordName: input.record,
          projection: selected ?? null,
          view: input.selection,
          selectionKind: 'current',
          exposure: { kind: 'metadata' },
        });
        if (
          (input.record !== recordName || input.selection !== 'accepted') &&
          canonicalJson(prior.observation.observed.head) !== canonicalJson(metadata.head)
        )
          rows.push(
            agentMessageSchema.parse({
              id: `${conversation.sourceSessionId}:record-observation:${randomUUID()}`,
              session_id: conversation.sourceSessionId,
              role: 'system',
              kind: 'record_observation',
              content: '',
              context_policy: STRUCTURAL_ROW_POLICY.record_observation,
              record_observations: [
                {
                  observed: metadata,
                  source: { kind: 'preparation', input_id: inputId, node_id: nodeId },
                },
              ],
              round_id: generateRoundId('pre'),
              message_index: 0,
              block_index: 0,
              timestamp: new Date().toISOString(),
            }),
          );
        continue;
      }
      const reason = prior ? 'changed' : 'initial';
      const text = renderCompiledPrompt(
        { kind: 'record-context', cardType: card.type },
        input.prompt.promptId,
        input.artifact.compiled,
        {
          cardType: card.type,
          recordSelection: canonicalJson({
            current: publicRecordSelection(current),
            prior: prior ? publicRecordSelection(prior.observation.observed) : null,
            reason,
          }),
          recordContent:
            includesBody && body !== undefined
              ? prepareRecordPromptContent(body, selected!.currentUrl)
              : canonicalJson(null),
        },
      );
      rows.push(
        agentMessageSchema.parse({
          id: `${conversation.sourceSessionId}:record-prompt:${randomUUID()}`,
          session_id: conversation.sourceSessionId,
          role: 'user',
          kind: 'record_prompt',
          content: text,
          instruction_origin: 'workflow_prompt',
          context_policy: {
            kind: 'content',
            storage: 'durable',
            replacement: { kind: 'retain' },
            evidence: { kind: 'none' },
            audience: 'primary_and_summarizer',
            compactable: input.prompt.compactable,
            ...(input.prompt.compactionKey === undefined
              ? {}
              : { compaction_key: input.prompt.compactionKey }),
          },
          record_prompt: { reference: input.prompt.promptId, node_id: nodeId, reason },
          record_observations: [
            {
              observed: current,
              source: {
                kind: 'prompt',
                input_id: inputId,
                node_id: nodeId,
                reference: input.prompt.promptId,
              },
            },
          ],
          round_id: generateRoundId('pre'),
          message_index: 0,
          block_index: 0,
          timestamp: new Date().toISOString(),
        }),
      );
    }
    rows.push(...preparedRows);
    return {
      rows,
      recordBlocks: [
        Object.freeze({
          id: `current-bootstrap:${card.id}`,
          role: 'system' as const,
          content: `Current accepted bootstrap, observed at this logical operation's preparation (not current-at-transport or new acceptance):\n${canonicalJson({ selection: publicRecordSelection(observed), content: accepted.content })}`,
          storage: 'activation_local' as const,
          replacement: { kind: 'retain' as const },
          audience: 'primary_and_summarizer' as const,
          evidence: { kind: 'none' as const },
        }),
      ],
    };
  };
}
