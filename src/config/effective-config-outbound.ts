import {
  outboundEffectiveSaivageConfigSchema,
  type OutboundEffectiveSaivageConfig,
  type SaivageConfig,
} from '../schemas/index.js';
import { redactUrl, SECRET_REDACTION_PLACEHOLDER } from '../redaction/text.js';

export function projectEffectiveConfigForOutbound(value: SaivageConfig): OutboundEffectiveSaivageConfig {
  const providers = Object.fromEntries(Object.entries(value.providers).map(([name, provider]) => {
    const { baseUrl: _baseUrl, accounts, ...providerFields } = provider;
    const projectedAccounts = accounts === undefined ? undefined : Object.fromEntries(
      Object.entries(accounts).map(([accountName, account]) => {
        const { baseUrl: _accountBaseUrl, ...accountFields } = account;
        return [accountName, {
          ...accountFields,
          apiKey: account.apiKey === undefined ? undefined : SECRET_REDACTION_PLACEHOLDER,
        }];
      }),
    );
    return [name, {
      ...providerFields,
      apiKey: provider.apiKey === undefined ? undefined : SECRET_REDACTION_PLACEHOLDER,
      accounts: projectedAccounts,
    }];
  }));
  const mcpServers = value.mcpServers === undefined ? undefined : Object.fromEntries(
    Object.entries(value.mcpServers).map(([name, server]) => server.transport === 'stdio'
      ? [name, {
          ...server,
          env: server.env === undefined
            ? undefined
            : Object.fromEntries(Object.keys(server.env).map((key) => [key, SECRET_REDACTION_PLACEHOLDER])),
        }]
      : [name, { ...server, url: redactUrl(server.url) }]),
  );
  return outboundEffectiveSaivageConfigSchema.parse({
    ...value,
    providers,
    mcpServers,
  });
}
