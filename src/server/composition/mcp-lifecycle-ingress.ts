import {
  PublicationOutcomeUnknownError,
  type ApplicationFatalPort,
} from '../../contracts/index.js';
import type { McpToolInvocationPort } from '../../mcp/manager-api.js';

/** Whole HTTP lifecycle calls, including manager post-stop continuations and cleanup. */
export class McpLifecycleIngress {
  #active = 0;
  constructor(
    private readonly manager: Pick<
      McpToolInvocationPort,
      'startServer' | 'stopServer' | 'restartServer'
    >,
    private readonly assertIngressAllowed: () => void,
    private readonly fatalPort: ApplicationFatalPort,
  ) {}

  hasActiveLifecycleCall(): boolean {
    return this.#active !== 0;
  }

  startServer(name: string): ReturnType<McpToolInvocationPort['startServer']> {
    return this.invoke(() => this.manager.startServer(name));
  }
  stopServer(name: string): ReturnType<McpToolInvocationPort['stopServer']> {
    return this.invoke(() => this.manager.stopServer(name));
  }
  restartServer(name: string): ReturnType<McpToolInvocationPort['restartServer']> {
    return this.invoke(() => this.manager.restartServer(name));
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
