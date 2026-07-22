import { effectiveSaivageConfigSchema, type SaivageConfig } from '../schemas/saivage-config.js';
import { SECRET_REDACTION_PLACEHOLDER } from '../redaction/text.js';

export function projectEffectiveConfigForOutbound(value: SaivageConfig): SaivageConfig {
  const projected = structuredClone(effectiveSaivageConfigSchema.parse(value));
  for (const provider of Object.values(projected.providers)) {
    if (provider.apiKey !== undefined) provider.apiKey = SECRET_REDACTION_PLACEHOLDER;
    for (const account of Object.values(provider.accounts ?? {})) if (account.apiKey !== undefined) account.apiKey = SECRET_REDACTION_PLACEHOLDER;
  }
  for (const server of Object.values(projected.mcpServers ?? {})) {
    if (server.transport === 'stdio' && server.env) for (const key of Object.keys(server.env)) server.env[key] = SECRET_REDACTION_PLACEHOLDER;
  }
  return effectiveSaivageConfigSchema.parse(projected);
}
