import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { ConversationSessionIdSchema, sha256Hex } from '../schemas/index.js';
import {
  throwIfPublicationOutcomeUnknown,
  type ProviderAttemptDiagnosticContext,
  type LlmTransportFailure,
} from '../contracts/index.js';
import { publishFreshFile } from '../persistence/index.js';
import {
  isSecretKey,
  projectDynamicForOutbound,
  redactTextForOutbound,
} from '../redaction/index.js';

const MAX_BYTES = 8 * 1024 * 1024;
const SCALAR_LIMIT = 512;
const presentationSchema = z
  .object({ value: z.string().max(SCALAR_LIMIT), redacted: z.boolean(), truncated: z.boolean() })
  .strict();
const countsSchema = z
  .object({
    structured_private: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
    private_replay: z.number().int().nonnegative(),
    data_urls: z.number().int().nonnegative(),
    tool_arguments_reencoded: z.number().int().nonnegative(),
    unprojectable_tool_arguments: z.number().int().nonnegative(),
    text_redactions: z.number().int().nonnegative(),
    structured_redactions: z.number().int().nonnegative(),
  })
  .strict();
// This family is private advisory output, not canonical provider evidence.
const diagnosticSchema = z
  .object({
    format_version: z.literal(1),
    kind: z.literal('failed-provider-request-diagnostic'),
    diagnostic_id: z.string().uuid(),
    activation_id: z.string().uuid(),
    source_session_id: ConversationSessionIdSchema.nullable(),
    invocation_session_id: z.union([
      ConversationSessionIdSchema,
      z.string().regex(/^internal:compaction-summary:[a-f0-9]{64}$/u),
    ]),
    input_id: z.string().uuid(),
    attempt_index: z.number().int().nonnegative(),
    purpose: z.enum(['primary', 'internal-summary']),
    contract_id: presentationSchema,
    protocol: presentationSchema,
    provider: presentationSchema,
    model: presentationSchema,
    submitted_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    observation: z.enum(['transport_failure', 'provider_refusal_finish_reason']),
    failure_kind: z.enum([
      'auth_permanent',
      'rate_limit',
      'server_transient',
      'timeout',
      'provider_protocol_error',
      'capability_mismatch',
      'input_context_exhausted',
      'content_policy',
      'output_token_limit_exceeded',
      'parse_error',
      'cancelled',
      'local_setup_error',
      'unknown',
      'content_filter',
    ]),
    provider_code: presentationSchema.nullable(),
    finish_reason: presentationSchema.nullable(),
    http_status: z.number().int().nullable(),
    embedded_status: z.number().int().nullable(),
    raw_request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    raw_request_utf8_bytes: z.number().int().nonnegative(),
    body_disposition: z.enum(['exact', 'redacted', 'omitted']),
    stored_body: z.string().nullable(),
    stored_body_sha256: z.string().nullable(),
    stored_body_utf8_bytes: z.number().int().nonnegative().nullable(),
    counts: countsSchema,
    reencoded: z.boolean(),
    privacy_policy: z.literal('failed-provider-request-privacy-1'),
    size_reason: z.enum(['raw_body_size_limit', 'stored_envelope_size_limit']).nullable(),
  })
  .strict();

interface Observation {
  context: ProviderAttemptDiagnosticContext;
  serializedBody: string;
  contractId: string;
  protocol: string;
  provider: string;
  model: string;
  submittedAt: string;
  completedAt: string;
  observation: 'transport_failure' | 'provider_refusal_finish_reason';
  failureKind: LlmTransportFailure['kind'] | 'content_filter';
  providerCode: string | null;
  providerCodeTruncated: boolean;
  finishReason: string | null;
  httpStatus: number | null;
  embeddedStatus: number | null;
}

function presentation(raw: string, credential: string | undefined) {
  const safe = redactTextForOutbound(credential ? raw.split(credential).join('[REDACTED]') : raw)
    .replace(/https?:\/\/[^\s]+/gi, '[OMITTED_URL]')
    .replace(/data:[^\s"'<>]*;base64,[A-Za-z0-9+/=]+/gi, '[OMITTED_DATA_URL]');
  return {
    value: safe.slice(0, SCALAR_LIMIT),
    redacted: safe !== raw,
    truncated: safe.length > SCALAR_LIMIT,
  };
}

function projectObservation(
  activationId: string,
  diagnosticId: string,
  observation: Observation,
  credential: string | undefined,
) {
  const counts = {
    structured_private: 0,
    images: 0,
    private_replay: 0,
    data_urls: 0,
    tool_arguments_reencoded: 0,
    unprojectable_tool_arguments: 0,
    text_redactions: 0,
    structured_redactions: 0,
  };
  const text = (value: string): string => {
    const withoutData = value.replace(/data:[^\s"'<>]*;base64,[A-Za-z0-9+/=]+/gi, () => {
      counts.data_urls++;
      return '[OMITTED_DATA_URL]';
    });
    const safe = redactTextForOutbound(
      credential ? withoutData.split(credential).join('[REDACTED]') : withoutData,
    );
    if (safe !== withoutData) counts.text_redactions++;
    return safe;
  };
  const project = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(project);
    if (value === null || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    if (object.type === 'reasoning' || object.type === 'item_reference') {
      counts.private_replay++;
      return '[OMITTED_PRIVATE_REPLAY]';
    }
    if (object.type === 'input_image' || object.type === 'image_url' || object.type === 'image') {
      counts.images++;
      return '[OMITTED_IMAGE]';
    }
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) {
      const storedKey = text(key);
      if (
        isSecretKey(key) ||
        /(?:^|[_-])(?:auth(?:entication|orization)?(?:[_-]?profiles?)?|headers?|cookies?|env(?:ironment)?|config(?:uration)?)$/.test(
          key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(),
        )
      ) {
        counts.structured_private++;
        output[storedKey] = '[OMITTED_PRIVATE_FIELD]';
      } else if (
        key === 'encrypted_content' ||
        key === 'previous_response_id' ||
        key === 'conversation' ||
        (key === 'id' &&
          typeof object.type === 'string' &&
          ['message', 'function_call', 'function_call_output'].includes(object.type))
      ) {
        counts.private_replay++;
        output[storedKey] = '[OMITTED_PRIVATE_REPLAY]';
      } else if (/^(?:image_url|image_data|b64_json|base64)$/i.test(key)) {
        counts.images++;
        output[storedKey] = '[OMITTED_IMAGE]';
      } else output[storedKey] = project(child);
    }
    const safe = projectDynamicForOutbound(output);
    if (JSON.stringify(safe) !== JSON.stringify(output)) counts.structured_redactions++;
    return safe;
  };
  const rawBytes = Buffer.byteLength(observation.serializedBody, 'utf8');
  let stored: string | null = null;
  if (rawBytes <= MAX_BYTES) {
    const body = JSON.parse(observation.serializedBody) as Record<string, unknown>;
    const argumentsProjection = (object: Record<string, unknown>) => {
      if (!('arguments' in object)) return;
      if (typeof object.arguments !== 'string') {
        counts.unprojectable_tool_arguments++;
        object.arguments = '[OMITTED_TOOL_ARGUMENTS]';
        return;
      }
      try {
        object.arguments = JSON.stringify(project(JSON.parse(object.arguments)));
        counts.tool_arguments_reencoded++;
      } catch {
        counts.unprojectable_tool_arguments++;
        object.arguments = '[OMITTED_TOOL_ARGUMENTS]';
      }
    };
    if (observation.protocol === 'openai-chat-completions' && Array.isArray(body.messages)) {
      for (const message of body.messages) {
        if (!message || !Array.isArray(message.tool_calls)) continue;
        for (const call of message.tool_calls)
          if (call?.function) argumentsProjection(call.function);
      }
    } else if (Array.isArray(body.input)) {
      for (const item of body.input) if (item?.type === 'function_call') argumentsProjection(item);
    }
    stored = JSON.stringify(project(body));
  }
  const present = (value: string) => presentation(value, credential);
  const document = {
    format_version: 1 as const,
    kind: 'failed-provider-request-diagnostic' as const,
    diagnostic_id: diagnosticId,
    activation_id: activationId,
    source_session_id: observation.context.sourceSessionId,
    invocation_session_id: observation.context.invocationSessionId,
    input_id: observation.context.inputId,
    attempt_index: observation.context.attemptIndex,
    purpose: observation.context.purpose,
    contract_id: present(observation.contractId),
    protocol: present(observation.protocol),
    provider: present(observation.provider),
    model: present(observation.model),
    submitted_at: observation.submittedAt,
    completed_at: observation.completedAt,
    observation: observation.observation,
    failure_kind: observation.failureKind,
    provider_code:
      observation.providerCode === null
        ? null
        : {
            ...present(observation.providerCode),
            truncated:
              observation.providerCodeTruncated || present(observation.providerCode).truncated,
          },
    finish_reason: observation.finishReason === null ? null : present(observation.finishReason),
    http_status: observation.httpStatus,
    embedded_status: observation.embeddedStatus,
    raw_request_sha256: sha256Hex(observation.serializedBody),
    raw_request_utf8_bytes: rawBytes,
    body_disposition:
      stored === null
        ? ('omitted' as const)
        : stored === observation.serializedBody
          ? ('exact' as const)
          : ('redacted' as const),
    stored_body: stored,
    stored_body_sha256: stored === null ? null : sha256Hex(stored),
    stored_body_utf8_bytes: stored === null ? null : Buffer.byteLength(stored, 'utf8'),
    counts,
    reencoded: stored !== null && stored !== observation.serializedBody,
    privacy_policy: 'failed-provider-request-privacy-1' as const,
    size_reason:
      rawBytes > MAX_BYTES
        ? ('raw_body_size_limit' as const)
        : (null as 'raw_body_size_limit' | 'stored_envelope_size_limit' | null),
  };
  let bytes = Buffer.from(JSON.stringify(diagnosticSchema.parse(document)) + '\n');
  if (bytes.length > MAX_BYTES) {
    document.body_disposition = 'omitted';
    document.stored_body = null;
    document.stored_body_sha256 = null;
    document.stored_body_utf8_bytes = null;
    document.size_reason = 'stored_envelope_size_limit';
    bytes = Buffer.from(JSON.stringify(diagnosticSchema.parse(document)) + '\n');
  }
  if (document.stored_body === null && bytes.length > 16 * 1024)
    throw new Error('Diagnostic metadata exceeds its bound.');
  return { id: document.diagnostic_id, bytes };
}

export class FailedProviderRequestDiagnostics {
  private readonly directory: string;
  private readonly deadline = performance.now() + 60 * 60 * 1000;
  private remaining = 16;
  private enabled = false;
  private limitNoticed = false;

  constructor(
    projectRoot: string,
    private readonly activationId: string,
  ) {
    this.directory = join(
      projectRoot,
      '.saivage',
      'diagnostics',
      'failed-provider-requests',
      activationId,
    );
    try {
      for (const path of [
        join(projectRoot, '.saivage', 'diagnostics'),
        join(projectRoot, '.saivage', 'diagnostics', 'failed-provider-requests'),
      ]) {
        try {
          mkdirSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      mkdirSync(this.directory);
      publishFreshFile(join(this.directory, '.gitignore'), Buffer.from('*\n'));
      this.enabled = true;
      console.error('Failed provider diagnostics enabled (finite private local capture).');
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      console.error('Failed provider diagnostics disabled (activation unavailable).');
    }
  }

  capture(observation: Observation, credential: string | undefined): void {
    if (!this.enabled) return;
    if (this.remaining === 0 || performance.now() >= this.deadline) {
      if (!this.limitNoticed) {
        this.limitNoticed = true;
        console.error('Failed provider diagnostics limit reached.');
      }
      return;
    }
    this.remaining--;
    try {
      const projected = projectObservation(
        this.activationId,
        randomUUID(),
        observation,
        credential,
      );
      publishFreshFile(join(this.directory, `${projected.id}.json`), projected.bytes);
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      console.error('Failed provider diagnostic capture failed.');
    }
  }
}
