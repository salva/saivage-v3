import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { PublicationOutcomeUnknownError } from '../contracts/index.js';
import {
  cardIdSchema,
  cardIdSegments,
  conversationSessionIdentity,
  ConversationSessionIdSchema,
  recordNameSchema,
  type ConversationSessionId,
  type RecordDefinition,
} from '../schemas/index.js';
import type { CompiledProjectWorkflows } from '../runtime/runtime-api.js';
import { cardHeadSchema } from './canonical-card-artifacts.js';
import { recordHeadSchema } from './canonical-record-artifacts.js';
import {
  CardSelectionInvalidError,
  inspectCardSelection,
  inspectRepairSelectedChildren,
  readCardRepairParent,
  readCard,
  restoreCardSelection,
  publishDiscardedCard,
} from './card-files.js';
import {
  inspectAuthoredRecordSelection,
  restoreAuthoredRecordSelection,
  readCurrentAuthoredRecord,
} from './authored-record-files.js';
import {
  inspectConversationIndex,
  inspectConversationSegment,
  readCurrentConversationSegment,
  restoreConversationIndex,
} from './conversation-file.js';
import {
  readCanonicalBytesOrMissing,
  truncateGrowingFile,
  type CanonicalReadInstrumentation,
} from './growing-file.js';
import {
  cardHeadFile,
  cardPreviousHeadFile,
  cardRecordHeadFile,
  cardRecordPreviousHeadFile,
  cardConversationVersionIndexFile,
  globalAgentConversationVersionIndexFile,
  conversationPreviousIndexFile,
  cardHistoryRoot,
  cardMailboxRoot,
  cardRecordsRoot,
  cardConversationsRoot,
} from './layout.js';

type RepairTarget =
  | { readonly kind: 'card'; readonly cardId: string }
  | { readonly kind: 'record'; readonly cardId: string; readonly name: string }
  | { readonly kind: 'conversation'; readonly sessionId: ConversationSessionId };

export function parseRepairTarget(value: string): RepairTarget {
  if (value.startsWith('card:'))
    return { kind: 'card', cardId: cardIdSchema.parse(value.slice(5)) };
  if (value.startsWith('record:')) {
    const parts = value.slice(7).split('/');
    if (parts.length !== 2) throw new Error('Expected record:ID/NAME.');
    return {
      kind: 'record',
      cardId: cardIdSchema.parse(parts[0]),
      name: recordNameSchema.parse(parts[1]),
    };
  }
  if (value.startsWith('conversation:'))
    return { kind: 'conversation', sessionId: ConversationSessionIdSchema.parse(value.slice(13)) };
  throw new Error('Expected card:ID, record:ID/NAME or conversation:SESSION_ID.');
}

interface RepairStep {
  readonly description: string;
  readonly apply: () => void;
}
interface RepairDecision {
  readonly summary: readonly string[];
  readonly steps: readonly RepairStep[];
  recheck(): void;
  validate(): void;
}
function json(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function corruption(error: unknown): void {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== undefined && code !== 'ENOENT' && code !== 'ERR_ENCODING_INVALID_ENCODED_DATA')
    throw error;
}

/** One offline call-local decision. Exact observations are discarded with the call. */
export function inspectRepairTarget(
  root: string,
  workflows: CompiledProjectWorkflows,
  target: RepairTarget,
  options: { readonly discardCard?: boolean; readonly cardType?: string } = {},
): RepairDecision {
  if ((options.discardCard || options.cardType !== undefined) && target.kind !== 'card')
    throw new Error('Discard/type options require an exact card target.');
  const observations: { path: string; bytes: Buffer | null }[] = [];
  const instrumentation: CanonicalReadInstrumentation = {
    onRead: () => {},
    onBytes: (path, bytes) => {
      if (!observations.some((row) => row.path === path)) observations.push({ path, bytes });
    },
  };
  const read = (path: string) => readCanonicalBytesOrMissing(path, instrumentation);
  const summary: string[] = [];
  const steps: RepairStep[] = [];
  const attic = join(root, '.saivage', 'repair-attic', randomUUID());
  let atticEstablished = false;
  const rootPresence: { path: string; present: boolean }[] = [];
  const present = (path: string) => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const move = (path: string, label = 'corrupt canonical path') => {
    const destination = join(attic, relative(root, path));
    steps.push({
      description: `Move exact ${label} ${relative(root, path)} to ${relative(root, destination)}.`,
      apply: () => {
        if (!atticEstablished) {
          mkdirSync(dirname(attic), { recursive: true });
          mkdirSync(attic);
          atticEstablished = true;
        }
        mkdirSync(dirname(destination), { recursive: true });
        try {
          renameSync(path, destination);
          for (const parent of [dirname(path), dirname(destination)]) {
            const descriptor = openSync(parent, constants.O_RDONLY);
            fsyncSync(descriptor);
            closeSync(descriptor);
          }
        } catch (error) {
          throw new PublicationOutcomeUnknownError(error);
        }
      },
    });
  };
  const consumedFailurePath = () => observations.at(-1)!;
  let validate: () => void;
  if (target.kind === 'card') {
    const parent = readCardRepairParent(root, target.cardId, instrumentation);
    const currentPath = cardHeadFile(root, target.cardId);
    const current = read(currentPath);
    let healthy = false;
    let selectorValid = false;
    let failedPath = currentPath;
    let currentType: string | undefined;
    if (current !== null) {
      try {
        const head = cardHeadSchema.parse(json(current));
        selectorValid = head.card_id === target.cardId;
        const candidate = inspectCardSelection(root, target.cardId, current, instrumentation);
        healthy = true;
        currentType = candidate.current.card.type;
        // Workflow/configuration damage is outside previous-selection repair.
      } catch (error) {
        corruption(error);
        failedPath = consumedFailurePath().path;
        if (error instanceof CardSelectionInvalidError || failedPath === currentPath)
          selectorValid = false;
      }
    }
    if (options.discardCard) {
      if (healthy)
        throw new Error(
          'Healthy current card selection refuses discard; record-only damage is not eligibility.',
        );
      const previous = read(cardPreviousHeadFile(root, target.cardId));
      let previousUsable = false;
      if (previous !== null) {
        try {
          inspectCardSelection(root, target.cardId, previous, instrumentation);
          previousUsable = true;
        } catch (error) {
          corruption(error);
        }
      }
      if (previousUsable)
        throw new Error('Usable previous card selection refuses discard; restore it separately.');
      const type = target.cardId === 'project' ? 'project' : options.cardType;
      if (!type)
        throw new Error(
          'Non-root discard requires explicit configured --card-type; type is operational input, not recovered evidence.',
        );
      if (
        target.cardId === 'project' &&
        options.cardType !== undefined &&
        options.cardType !== 'project'
      )
        throw new Error('Project discard has fixed project type.');
      const workflow = admitCardType(type, parent?.type);
      if (cardIdSegments(target.cardId).length === 12 && workflow.permittedChildTypes.size !== 0)
        throw new Error('Depth-twelve discard requires a compiled leaf type.');
      summary.push(
        `Explicit synthetic type: ${type}; non-root supplied type is operational input, not recovered metadata.`,
        'DESTRUCTIVE: Both own card selections are unusable. Discard all own generated history, mailbox, drafts, records and conversations; original metadata and requirements are lost. No prior completion/reviewer verdict is retained.',
        'The entire former descendant reachability is lost, with UNKNOWN count/content. Children are not inspected or moved. Parent link, siblings, globals, source, config, credentials and logs stay untouched. Unrelated dependencies may remain invalid and block restart; no consistency guarantee.',
        'Repair/startup launch no work. FAILED blocks direct activation only while FAILED: a later explicit ancestor Run may let its Planner reopen to CHANGED and execute the card with placeholder requirements, without operator replacement. Replace requirements first as a recommendation, not an enforced prerequisite.',
      );
      if (target.cardId === 'project')
        summary.push(
          'PROJECT DISCARD unlinks every previous project descendant; global histories remain physically retained.',
        );
      for (const path of [
        currentPath,
        cardPreviousHeadFile(root, target.cardId),
        cardHistoryRoot(root, target.cardId),
        cardMailboxRoot(root, target.cardId),
        cardRecordsRoot(root, target.cardId),
        cardConversationsRoot(root, target.cardId),
      ]) {
        const exists = present(path);
        rootPresence.push({ path, present: exists });
        if (exists) move(path, 'card-owned discard root');
        else summary.push(`Absent own root: ${relative(root, path)}; no move.`);
      }
      steps.push({
        description:
          'Publish synthetic runtime:repair FAILED version 1, accepted loss status/bootstrap placeholders and empty configured card sessions; no children or old verdicts recovered.',
        apply: () => {
          publishDiscardedCard(root, target.cardId, workflow);
        },
      });
    } else if (healthy) {
      admitCardType(currentType!, parent?.type);
      summary.push('Current card selection is healthy; no repair effects.');
    } else {
      const previous = read(cardPreviousHeadFile(root, target.cardId));
      if (previous === null)
        throw new Error('Previous card selection unavailable; no restoration candidate.');
      const candidate = inspectCardSelection(root, target.cardId, previous, instrumentation);
      admitCardType(candidate.current.card.type, parent?.type);
      for (const child of inspectRepairSelectedChildren(root, candidate, instrumentation))
        admitCardType(child.type, candidate.current.card.type);
      summary.push(
        'Restore exactly the previous card selection. Latest membership/lifecycle/queue changes may be lost; prior state may be resurrected and descendants unlinked.',
      );
      if (current !== null && !selectorValid) move(currentPath);
      steps.push({
        description: 'Fresh-publish previous card payload with a new head identity.',
        apply: () =>
          restoreCardSelection(
            root,
            target.cardId,
            candidate.selection,
            current !== null && selectorValid ? 'replacement' : 'initial',
          ),
      });
      if (selectorValid && observations.find((row) => row.path === failedPath)?.bytes !== null)
        move(failedPath);
    }
    validate = () => {
      const bytes = readCanonicalBytesOrMissing(currentPath);
      if (bytes === null) throw new Error('Repaired card head missing.');
      inspectCardSelection(root, target.cardId, bytes);
      if (options.discardCard) {
        const card = readCard(root, target.cardId)!;
        const workflow = workflows.cardTypes.get(card.type)!;
        for (const record of workflow.records.values())
          if (record.bootstrap || record.name === 'status.md')
            readCurrentAuthoredRecord(root, card, {
              filename: record.name,
              format: record.format,
              schema: record.schema,
              bootstrap: record.bootstrap,
              declared: true,
            });
        if (!workflow.records.has('status.md'))
          readCurrentAuthoredRecord(root, card, {
            filename: 'status.md',
            format: 'markdown',
            schema: 'authored-record.v1',
            bootstrap: false,
            declared: false,
          });
        const names = new Set<string>();
        for (const state of workflow.states.values())
          if (state.kind === 'node' && state.agent.session === 'card') names.add(state.agent.name);
        for (const name of names)
          readCurrentConversationSegment(
            root,
            ConversationSessionIdSchema.parse(`agent:${name}:${target.cardId}`),
          );
      }
    };
  } else if (target.kind === 'record') {
    const card = readCard(root, target.cardId, instrumentation);
    if (!card) throw new Error('Record target card is not active and linked.');
    const workflow = admitCardType(card.type);
    const configured = workflow.records.get(target.name);
    const definition: RecordDefinition = configured
      ? {
          filename: configured.name,
          format: configured.format,
          schema: configured.schema,
          bootstrap: configured.bootstrap,
          declared: true,
        }
      : {
          filename: target.name,
          format: 'markdown',
          schema: 'authored-record.v1',
          bootstrap: false,
          declared: false,
        };
    const currentPath = cardRecordHeadFile(root, card.id, definition);
    const current = read(currentPath);
    let healthy = false;
    let selectorValid = false;
    let failedPath = currentPath;
    if (current !== null) {
      try {
        const head = recordHeadSchema.parse(json(current));
        selectorValid =
          head.card_id === card.id &&
          head.record_name === definition.filename &&
          head.record_format === definition.format &&
          head.schema === definition.schema &&
          (!definition.bootstrap || head.accepted !== null);
        inspectAuthoredRecordSelection(root, card.id, definition, current, instrumentation);
        healthy = true;
      } catch (error) {
        corruption(error);
        failedPath = consumedFailurePath().path;
      }
    }
    if (healthy) summary.push('Current record selection is healthy; no repair effects.');
    else {
      const previous = read(cardRecordPreviousHeadFile(root, card.id, definition));
      if (current === null && previous === null && !definition.bootstrap)
        summary.push('Optional record is absent; no repair effects.');
      else {
        if (previous === null)
          throw new Error('Previous record selection unavailable; no restoration candidate.');
        const candidate = inspectAuthoredRecordSelection(
          root,
          card.id,
          definition,
          previous,
          instrumentation,
        );
        summary.push(
          'Restore exactly previous accepted/draft selection; latest acceptance or draft changes may be lost. Record failure never authorizes healthy-card discard.',
        );
        if (current !== null && !selectorValid) move(currentPath);
        steps.push({
          description: 'Fresh-publish previous record payload with a new head identity.',
          apply: () =>
            restoreAuthoredRecordSelection(
              root,
              card.id,
              definition,
              candidate.head,
              current !== null && selectorValid ? 'replacement' : 'initial',
            ),
        });
        if (selectorValid && observations.find((row) => row.path === failedPath)?.bytes !== null)
          move(failedPath);
      }
    }
    validate = () => {
      readCurrentAuthoredRecord(root, card, definition);
    };
  } else {
    const identity = conversationSessionIdentity(target.sessionId);
    if (identity.cardId === null) {
      if (!workflows.selectedGlobalParticipants.has(identity.agentName))
        throw new Error('Conversation is not a configured global participant.');
    } else {
      const card = readCard(root, identity.cardId, instrumentation);
      if (!card) throw new Error('Conversation card is not active and linked.');
      const workflow = admitCardType(card.type);
      if (
        ![...workflow.states.values()].some(
          (state) =>
            state.kind === 'node' &&
            state.agent.session === 'card' &&
            state.agent.name === identity.agentName,
        )
      )
        throw new Error('Conversation is not a configured card session.');
    }
    const currentPath =
      identity.cardId === null
        ? globalAgentConversationVersionIndexFile(root, identity.agentName)
        : cardConversationVersionIndexFile(root, identity.cardId, identity.agentName);
    const current = read(currentPath);
    let index: ReturnType<typeof inspectConversationIndex> | null = null;
    if (current !== null) {
      try {
        index = inspectConversationIndex(root, target.sessionId, current);
      } catch (error) {
        corruption(error);
      }
    }
    if (index === null) {
      const previous = read(conversationPreviousIndexFile(currentPath));
      if (previous === null)
        throw new Error('Previous conversation index unavailable; no restoration candidate.');
      const candidate = inspectConversationIndex(root, target.sessionId, previous);
      const segment = inspectConversationSegment(
        root,
        target.sessionId,
        candidate,
        undefined,
        instrumentation,
      );
      summary.push(
        'Restore exact previous index; newest indexed interactions may be lost. Unknown potentially days-long interactions since compaction; tool effects are not undone.',
      );
      describeSegment(segment);
      if (current !== null) move(currentPath);
      steps.push({
        description: 'Fresh-publish previous conversation index.',
        apply: () => restoreConversationIndex(root, target.sessionId, candidate, 'initial'),
      });
      tail(segment);
    } else {
      let segment: ReturnType<typeof inspectConversationSegment>;
      try {
        segment = inspectConversationSegment(
          root,
          target.sessionId,
          index,
          undefined,
          instrumentation,
        );
      } catch (error) {
        corruption(error);
        const failed = consumedFailurePath();
        if (index.versions.length < 2)
          throw new Error('First segment unavailable; no indexed predecessor rollback.');
        const predecessor = inspectConversationSegment(
          root,
          target.sessionId,
          index,
          index.versions.length - 1,
          instrumentation,
        )!;
        const versions = index.versions.slice(0, -1);
        const entry = versions.at(-1)!;
        const removed = index.versions.at(-1)!;
        const restored = {
          ...index,
          versions,
          current_version: entry.version,
          current_filename: entry.filename,
        };
        summary.push(
          'Roll back exactly one indexed segment. Unknown potentially days-long interactions since compaction; tool effects are not undone.',
        );
        summary.push(`Removed selection: segment ${removed.entry_id}, version ${removed.version}.`);
        describeSegment(predecessor);
        steps.push({
          description: 'Publish index selecting its immediate wholly valid indexed predecessor.',
          apply: () => restoreConversationIndex(root, target.sessionId, restored, 'replacement'),
        });
        if (failed.bytes !== null) move(failed.path);
        segment = null;
      }
      if (steps.length === 0) {
        describeSegment(segment);
        tail(segment);
        if (steps.length === 0) summary.push('Current conversation is healthy; no repair effects.');
      }
    }
    validate = () => {
      readCurrentConversationSegment(root, target.sessionId);
    };
  }
  return {
    summary,
    steps,
    validate,
    recheck: () => {
      for (const row of observations) {
        const now = readCanonicalBytesOrMissing(row.path);
        if (row.bytes === null ? now !== null : now === null || !row.bytes.equals(now))
          throw new Error('Exact inspected data changed during confirmation; repair refused.');
      }
      for (const row of rootPresence)
        if (present(row.path) !== row.present)
          throw new Error(
            'Exact discard root presence changed during confirmation; discard refused.',
          );
    },
  };

  function admitCardType(type: string, parentType?: string) {
    const workflow = workflows.cardTypes.get(type);
    if (
      !workflow ||
      (parentType !== undefined &&
        !workflows.cardTypes.get(parentType)?.permittedChildTypes.has(type))
    )
      throw new Error('Card type does not match configured workflow admission.');
    return workflow;
  }
  function describeSegment(segment: ReturnType<typeof inspectConversationSegment>) {
    if (!segment) {
      summary.push('Selected conversation index is empty.');
      return;
    }
    summary.push(
      `Selected segment ${segment.projection.entry.entry_id}, version ${segment.projection.entry.version}, ${segment.projection.rows.length} validated rows; published ${segment.projection.entry.created_at}.`,
    );
    if (segment.projection.entry.genesis.kind === 'compacted')
      summary.push(
        `Known compaction coverage boundary: ${segment.projection.entry.genesis.covered_through_message_id}; source version ${segment.projection.entry.genesis.source_version}.`,
      );
  }
  function tail(segment: ReturnType<typeof inspectConversationSegment>) {
    if (segment && segment.tornSuffixLength > 0)
      steps.push({
        description: `Truncate only ${relative(root, segment.path)} to ${segment.retainedLength} retained bytes; discard ${segment.tornSuffixLength} unterminated suffix bytes.`,
        apply: () => truncateGrowingFile(segment.path, segment.retainedLength),
      });
  }
}
