import { randomUUID } from 'node:crypto';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../contracts/index.js';
import type { ManagedProcessScope, ProcessRunner } from '../runtime/runtime-api.js';
import { invokeTool, type InvocationSurface, type ToolSettlementInput } from '../tools/tool-api.js';
import { recordExternalToolCall } from './external-tool-call.js';

export class ExternalAnalystClosedError extends Error {}
export class ExternalAnalystExecutionError extends Error {}

/** Process-local application work ownership, not a client request/session registry. */
export class ExternalAnalystOperations {
  #open = true;
  #active = new Set<{ controller: AbortController; task: Promise<ToolSettlementInput> }>();
  #cleanup: Promise<void> | null = null;
  constructor(
    private readonly input: {
      projectRoot: string;
      projectIdentityDigest: string;
      principal: string;
      surface: InvocationSurface;
      processRunner: ProcessRunner;
      directScope: ManagedProcessScope;
      fatalPort: ApplicationFatalPort;
      onOwnerFailure(error: unknown): void;
    },
  ) {}

  get surface(): InvocationSurface {
    return this.input.surface;
  }

  invoke(name: string, args: unknown): Promise<ToolSettlementInput> {
    if (!this.#open)
      return Promise.reject(
        new ExternalAnalystClosedError('External Analyst admission is closed.'),
      );
    const controller = new AbortController();
    const context = {
      kind: 'external' as const,
      invocationId: randomUUID(),
      principal: this.input.principal,
      signal: controller.signal,
    };
    // No await precedes installation of this work's application-owned join.
    const entry: { controller: AbortController; task: Promise<ToolSettlementInput> } = {
      controller,
      task: invokeTool(this.input.surface, name, args, context).then(
        (settlement) => {
          try {
            recordExternalToolCall({
              projectRoot: this.input.projectRoot,
              projectIdentityDigest: this.input.projectIdentityDigest,
              context,
              surface: this.input.surface,
              requestedTool: name,
              settlement,
            });
          } catch (error) {
            return this.fail(entry, error);
          }
          this.#active.delete(entry);
          return settlement;
        },
        (error) => this.fail(entry, error),
      ),
    };
    this.#active.add(entry);
    return entry.task;
  }

  private fail(
    entry: { controller: AbortController; task: Promise<ToolSettlementInput> },
    error: unknown,
  ): never {
    if (error instanceof PublicationOutcomeUnknownError)
      this.input.fatalPort.publicationOutcomeUnknown(error);
    this.#active.delete(entry);
    this.input.onOwnerFailure(error);
    throw new ExternalAnalystExecutionError(
      'External Analyst operation failed; effects may have occurred.',
    );
  }

  closeAdmission(): void {
    this.#open = false;
    for (const { controller } of this.#active) controller.abort(new Error('Application stopping.'));
  }

  cleanupForApplicationStop(): Promise<void> {
    if (this.#cleanup) return this.#cleanup;
    this.closeAdmission();
    let containment: ReturnType<ProcessRunner['closeAndTerminateDirectScope']>;
    try {
      containment = this.input.processRunner
        .closeAndTerminateDirectScope({
          directScope: this.input.directScope,
          category: 'operator_session',
          reason: 'application stopping',
        })
        .catch((error: unknown) => {
          if (error instanceof PublicationOutcomeUnknownError)
            this.input.fatalPort.publicationOutcomeUnknown(error);
          throw error;
        });
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        this.input.fatalPort.publicationOutcomeUnknown(error);
      containment = Promise.reject(error);
    }
    this.#cleanup = Promise.allSettled([
      containment,
      Promise.allSettled([...this.#active].map(({ task }) => task)),
    ] as const).then(([stopped, joined]) => {
      const results = joined.status === 'fulfilled' ? joined.value : [joined];
      if (
        stopped.status === 'rejected' ||
        stopped.value.failed.length > 0 ||
        results.some((result) => result.status === 'rejected')
      )
        throw new Error('External Analyst application cleanup failed.');
    });
    return this.#cleanup;
  }
}
