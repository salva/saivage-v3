import type { SaivageConfig } from './config-schema.js';
import { getModelListForRole } from './config-schema.js';
import { ProviderRegistry, type Candidate, type Provider, type Account } from './provider.js';
import {
  getAuthProfile,
  refreshAuthProfile,
  isProfileExpired,
} from '../auth/oauth-profiles.js';

// ── Model Router ──────────────────────────────────────────────

/**
 * Resolves an agent role into an ordered chain of
 * provider/account/model candidates.
 */
export class ModelRouter {
  private registry: ProviderRegistry;
  private config: SaivageConfig;
  private projectRoot?: string;

  constructor(
    config: SaivageConfig,
    registry: ProviderRegistry,
    projectRoot?: string,
  ) {
    this.config = config;
    this.registry = registry;
    this.projectRoot = projectRoot;
  }

  /**
   * Resolve a role into an ordered candidate chain.
   *
   * The chain is built as follows:
   * 1. Iterate the role's configured model list in order.
   * 2. For each model, find providers that can serve it.
   * 3. Sort providers by priority, then skip those in cooldown.
   * 4. For each provider, sort accounts by priority.
   * 5. Produce provider/account/model candidates.
   * 6. Move to next model only after all candidates for current
   *    model are exhausted.
   *
   * If the config includes model equivalents, they are tried
   * after all candidates for the current model are exhausted.
   * If failover chains are configured, they are tried after
   * equivalents are exhausted.
   */
  async resolve(role: string): Promise<Candidate[]> {
    const modelList = getModelListForRole(this.config, role);
    const candidates: Candidate[] = [];

    const equivalents = this.config.models.equivalents ?? [];
    const failover = this.config.models.failover ?? {};
    // Also support top-level failover (backwards compat)
    const topFailover =
      (this.config as Record<string, unknown>).failover as
        | Record<string, string[]>
        | undefined;

    const seenModels = new Set<string>();

    for (const model of modelList) {
      if (seenModels.has(model)) continue;
      seenModels.add(model);

      // Add candidates for this model
      const modelCandidates = await this.resolveModel(model);
      candidates.push(...modelCandidates);

      // If we found healthy candidates, we're done
      if (modelCandidates.length > 0) continue;

      // Try equivalents
      const eqGroup = equivalents.find((group) => group.includes(model));
      if (eqGroup) {
        for (const eqModel of eqGroup) {
          if (eqModel === model || seenModels.has(eqModel)) continue;
          seenModels.add(eqModel);
          const eqCandidates = await this.resolveModel(eqModel);
          if (eqCandidates.length > 0) {
            candidates.push(...eqCandidates);
            break; // Use first equivalent group that works
          }
        }
      }

      // Try failover
      const chain = failover[model] ?? topFailover?.[model];
      if (chain) {
        for (const foModel of chain) {
          if (seenModels.has(foModel)) continue;
          seenModels.add(foModel);
          const foCandidates = await this.resolveModel(foModel);
          if (foCandidates.length > 0) {
            candidates.push(...foCandidates);
            break;
          }
        }
      }
    }

    return candidates;
  }

  /**
   * Resolve a single model to its healthy candidates.
   * Providers sorted by priority, then accounts sorted by priority.
   * Also checks for expired OAuth auth profiles and refreshes them
   * before including candidates. Accounts with unrecoverable auth
   * failures are skipped.
   */
  private async resolveModel(model: string): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    const providers = this.registry.getProvidersForModel(model);

    for (const provider of providers) {
      const acctCandidates = provider.getCandidatesForModel(model);
      for (const c of acctCandidates) {
        if (!this.registry.isHealthy(c)) continue;

        // Find the account to check auth
        const account = c.account != null
          ? provider.getAllAccounts().find((a) => a.name === c.account)
          : provider.implicitAccount;

        if (account) {
          const authOk = await this.ensureAuthNotExpired(provider, account);
          if (!authOk) continue; // Skip this account if auth can't be refreshed
        }

        candidates.push(c);
      }
    }

    return candidates;
  }

  /**
   * Check whether a provider/account has an expired OAuth auth profile,
   * and attempt to refresh it if needed.
   *
   * @returns true if the account is usable (auth is ok or not needed),
   *          false if auth is required but could not be refreshed.
   */
  private async ensureAuthNotExpired(
    provider: Provider,
    account: Account,
  ): Promise<boolean> {
    const authProfileName = account.authProfile ?? provider.authProfile;
    if (!authProfileName || !this.projectRoot) {
      // No auth profile configured, or no project root — account is usable
      return true;
    }

    try {
      const profile = await getAuthProfile(this.projectRoot, authProfileName);
      if (!profile) {
        // Auth profile configured but not found — can't use this account
        console.error(
          `[model-router] Auth profile '${authProfileName}' not found for ` +
          `provider '${provider.name}' account '${account.name}'. Skipping.`,
        );
        return false;
      }

      if (!isProfileExpired(profile)) {
        // Not expired — usable as-is
        return true;
      }

      // Profile is expired — attempt refresh
      const tokenEndpoint = account.effectiveTokenEndpoint(
        provider.tokenEndpoint,
        account.effectiveBaseUrl(provider.baseUrl),
      );

      console.error(
        `[model-router] Auth profile '${authProfileName}' is expired. ` +
        `Refreshing for provider '${provider.name}' account '${account.name}'...`,
      );

      const refreshed = await refreshAuthProfile(
        this.projectRoot,
        authProfileName,
        tokenEndpoint,
      );

      if (!refreshed) {
        console.error(
          `[model-router] Failed to refresh expired auth profile '${authProfileName}' ` +
          `for provider '${provider.name}' account '${account.name}'. Skipping.`,
        );
        return false;
      }

      console.error(
        `[model-router] Refreshed expired auth profile '${authProfileName}' ` +
        `for provider '${provider.name}' account '${account.name}'.`,
      );
      return true;
    } catch (err) {
      console.error(
        `[model-router] Error checking auth profile '${authProfileName}' ` +
        `for provider '${provider.name}' account '${account.name}': ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get the next healthy candidate for a role, skipping ones
   * that are in cooldown. Returns null if none available.
   */
  async nextCandidate(role: string): Promise<Candidate | null> {
    const chain = await this.resolve(role);
    return chain.length > 0 ? chain[0] : null;
  }

  /**
   * Get the underlying provider registry.
   */
  getRegistry(): ProviderRegistry {
    return this.registry;
  }

  /**
   * Get the config.
   */
  getConfig(): SaivageConfig {
    return this.config;
  }
}
