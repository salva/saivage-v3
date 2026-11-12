import {
  PublicationOutcomeUnknownError,
  type ApplicationFatalPort,
} from '../../contracts/index.js';
import type { McpToolInvocationPort } from '../../mcp/manager-api.js';
import { MCP_OPERATOR_CALLER } from '../../mcp/manager-api.js';
import type { McpAccessPolicy } from '../../schemas/index.js';

type OperatorLifecycleResult = Awaited<ReturnType<McpToolInvocationPort['startServer']>> & {
  toolCount: number;
};

// Operator authority has project reach, so management results retain their count.
function operatorResult(
  result: Awaited<ReturnType<McpToolInvocationPort['startServer']>>,
): OperatorLifecycleResult {
  return { ...result, toolCount: result.toolCount! };
}

/** Whole HTTP management calls, including manager post-stop continuations and cleanup. */
export class McpLifecycleIngress {
  #active = 0;
  constructor(
    private readonly manager: Pick<
      McpToolInvocationPort,
      'startServer' | 'stopServer' | 'restartServer' | 'setServerScope'
    >,
    private readonly assertIngressAllowed: () => void,
    private readonly fatalPort: ApplicationFatalPort,
  ) {}

  hasActiveLifecycleCall(): boolean {
    return this.#active !== 0;
  }

  startServer(name: string): Promise<OperatorLifecycleResult> {
    return this.invoke(() => this.manager.startServer(MCP_OPERATOR_CALLER, name)).then(
      operatorResult,
    );
  }
  stopServer(name: string): Promise<OperatorLifecycleResult> {
    return this.invoke(() => this.manager.stopServer(MCP_OPERATOR_CALLER, name)).then(
      operatorResult,
    );
  }
  restartServer(name: string): Promise<OperatorLifecycleResult> {
    return this.invoke(() => this.manager.restartServer(MCP_OPERATOR_CALLER, name)).then(
      operatorResult,
    );
  }
  setServerScope(
    name: string,
    policy: McpAccessPolicy,
  ): Promise<ReturnType<McpToolInvocationPort['setServerScope']>> {
    return this.invoke(async () => this.manager.setServerScope(MCP_OPERATOR_CALLER, name, policy));
  }

  private async invoke<T>(call: () => Promise<T>): Promise<T> {
    this.assertIngressAllowed();
    this.#active += 1;
    let result: T;
    try {
      result = await call();
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        this.fatalPort.publicationOutcomeUnknown(error);
      this.#active -= 1;
      throw error;
    }
    this.#active -= 1;
    return result;
  }
}
