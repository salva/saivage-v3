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

export class McpToolInvocationInstaller {
  constructor(private readonly installAuthority: (port: McpToolInvocationPort) => void) {}

  install(port: McpToolInvocationPort): void {
    this.installAuthority(port);
  }
}

export interface McpToolInvocationInstallation {
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
    getServerTools: (name) => authority().getServerTools(name),
    findToolCapability: (serverName, toolName) => authority().findToolCapability(serverName, toolName),
    invokeTool: (serverName, toolName, args, options) => authority().invokeTool(serverName, toolName, args, options),
  };
  Object.freeze(port);
  const installer = new McpToolInvocationInstaller((next) => {
    if (installed) throw new McpToolInvocationAlreadyInstalledError();
    installed = next;
  });
  Object.freeze(installer);
  return Object.freeze({ port, installer });
}
