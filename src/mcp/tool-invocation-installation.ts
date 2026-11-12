import type { McpToolInvocationPort } from './mcp-manager.js';

const NOT_INSTALLED_MESSAGE = 'MCP tool invocation authority is not installed.';
const ALREADY_INSTALLED_MESSAGE = 'MCP tool invocation authority is already installed.';

export class McpToolInvocationNotInstalledError extends Error {
  constructor() {
    super(NOT_INSTALLED_MESSAGE);
    this.name = 'McpToolInvocationNotInstalledError';
  }
}

export class McpToolInvocationAlreadyInstalledError extends Error {
  constructor() {
    super(ALREADY_INSTALLED_MESSAGE);
    this.name = 'McpToolInvocationAlreadyInstalledError';
  }
}

class McpToolInvocationInstaller {
  constructor(private readonly installAuthority: (port: McpToolInvocationPort) => void) {}

  install(port: McpToolInvocationPort): void {
    this.installAuthority(port);
  }
}

interface McpToolInvocationInstallation {
  readonly port: McpToolInvocationPort;
  readonly installer: McpToolInvocationInstaller;
}

export function createMcpToolInvocationInstallation(): McpToolInvocationInstallation {
  let installed: McpToolInvocationPort | null = null;
  const authority = (): McpToolInvocationPort => {
    if (!installed) throw new McpToolInvocationNotInstalledError();
    return installed;
  };

  const port: McpToolInvocationPort = {
    registerServer: (...args) => authority().registerServer(...args),
    replaceServer: (...args) => authority().replaceServer(...args),
    unregisterServer: (...args) => authority().unregisterServer(...args),
    setServerScope: (...args) => authority().setServerScope(...args),
    getStatus: (...args) => authority().getStatus(...args),
    getServerStatus: (...args) => authority().getServerStatus(...args),
    startServer: (...args) => authority().startServer(...args),
    stopServer: (...args) => authority().stopServer(...args),
    restartServer: (...args) => authority().restartServer(...args),
    getServerCatalog: (...args) => authority().getServerCatalog(...args),
    refreshServerCatalog: (...args) => authority().refreshServerCatalog(...args),
    invokeTool: (...args) => authority().invokeTool(...args),
  };
  Object.freeze(port);
  const installer = new McpToolInvocationInstaller((next) => {
    if (installed) throw new McpToolInvocationAlreadyInstalledError();
    installed = next;
  });
  Object.freeze(installer);
  return Object.freeze({ port, installer });
}
