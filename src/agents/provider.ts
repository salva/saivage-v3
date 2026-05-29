import type {
  ProviderEntry,
  ProviderAccount as ConfigAccount,
  ProviderCapabilities,
  SaivageConfig,
} from './config-schema.js';
import {
  builtInCapabilitiesForProvider,
  mergeCapabilities,
  type EffectiveProviderCapabilities,
} from './provider-capabilities.js';

// ── Candidate ─────────────────────────────────────────────────

/**
 * A concrete provider/account/model triple that the router can attempt.
 */
export interface Candidate {
  provider: string;
  account: string | null; // null = implicit single account for provider
  model: string;
}

/**
 * Serialize a Candidate into a stable string key for health tracking.
 */
export function candidateKey(c: Candidate): string {
  return `${c.provider}/${c.account ?? '_'}/${c.model}`;
}

/**
 * Parse a candidate key back into a Candidate.
 */
export function parseCandidateKey(key: string): Candidate {
  const parts = key.split('/');
  if (parts.length !== 3) {
    throw new Error(`Invalid candidate key: ${key}`);
  }
  return {
    provider: parts[0],
    account: parts[1] === '_' ? null : parts[1],
    model: parts[2],
  };
}

// ── Account ───────────────────────────────────────────────────

export class Account {
  readonly name: string;
  readonly priority: number;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly tokenEndpoint?: string;
  readonly authProfile?: string;
  readonly models?: string[]; // subset override
  readonly capabilities?: ProviderCapabilities;

  constructor(name: string, entry: ConfigAccount) {
    this.name = name;
    this.priority = entry.priority ?? 100;
    this.apiKey = entry.apiKey;
    this.baseUrl = entry.baseUrl;
    this.tokenEndpoint = entry.tokenEndpoint;
    this.authProfile = entry.authProfile;
    this.models = entry.models;
    this.capabilities = entry.capabilities;
  }

  /** Check whether this account can serve a given model. */
  canServe(model: string, providerModelSet: Set<string>): boolean {
    if (this.models) {
      return this.models.includes(model);
    }
    return providerModelSet.has(model);
  }

  /** Compute the effective API key (account overrides provider). */
  effectiveApiKey(providerApiKey?: string): string | undefined {
    return this.apiKey ?? providerApiKey;
  }

  /** Compute the effective base URL. */
  effectiveBaseUrl(providerBaseUrl?: string): string | undefined {
    return this.baseUrl ?? providerBaseUrl;
  }

  /**
   * Compute the effective OAuth token endpoint.
   * Resolution order: account → provider → inferred from provider baseUrl.
   */
  effectiveTokenEndpoint(
    providerTokenEndpoint?: string,
    providerBaseUrl?: string,
  ): string | undefined {
    if (this.tokenEndpoint) return this.tokenEndpoint;
    if (providerTokenEndpoint) return providerTokenEndpoint;
    if (providerBaseUrl) {
      try {
        const url = new URL(providerBaseUrl);
        return `${url.origin}/oauth/token`;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

// ── Provider ──────────────────────────────────────────────────

export class Provider {
  readonly name: string;
  readonly priority: number;
  readonly models: Set<string>;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly tokenEndpoint?: string;
  readonly authProfile?: string;
  readonly capabilities?: ProviderCapabilities;
  readonly modelCapabilities?: Record<string, ProviderCapabilities>;
  readonly accounts: Account[];
  /** Implicit account when no explicit accounts are configured */
  readonly implicitAccount: Account;

  constructor(name: string, entry: ProviderEntry) {
    this.name = name;
    this.priority = entry.priority ?? 50;
    this.models = new Set(entry.models ?? []);
    this.apiKey = entry.apiKey;
    this.baseUrl = entry.baseUrl;
    this.tokenEndpoint = entry.tokenEndpoint;
    this.authProfile = entry.authProfile;
    this.capabilities = entry.capabilities;
    this.modelCapabilities = entry.modelCapabilities;

    // Build account list
    if (entry.accounts) {
      this.accounts = Object.entries(entry.accounts)
        .map(([acctName, acctEntry]) => new Account(acctName, acctEntry))
        .sort((a, b) => a.priority - b.priority);
    } else {
      this.accounts = [];
    }

    // Create implicit account from provider-level settings
    this.implicitAccount = new Account('_implicit', {
      priority: 0,
      apiKey: entry.apiKey,
      baseUrl: entry.baseUrl,
      tokenEndpoint: entry.tokenEndpoint,
      authProfile: entry.authProfile,
      capabilities: entry.capabilities,
    });
  }

  /** Can this provider serve the given model? */
  canServe(model: string): boolean {
    return this.models.has(model);
  }

  /**
   * Get the ordered list of accounts that can serve a given model.
   * Sorted by account priority (lower = higher priority).
   * Returns the implicit account if no explicit accounts exist
   * or none can serve the model.
   */
  getAccountsForModel(model: string): Account[] {
    const eligible = this.accounts.filter((a) =>
      a.canServe(model, this.models),
    );
    if (eligible.length > 0) {
      return eligible; // already sorted by priority in constructor
    }
    // Fallback: try implicit account if it can serve
    if (this.implicitAccount.canServe(model, this.models)) {
      return [this.implicitAccount];
    }
    return [];
  }

  /** Compute effective capabilities for an account/model using model → account → provider → built-in → global precedence. */
  getEffectiveCapabilities(model: string, accountName: string | null): EffectiveProviderCapabilities {
    const account = accountName != null
      ? this.getAllAccounts().find((a) => a.name === accountName)
      : this.implicitAccount;
    const builtIn = builtInCapabilitiesForProvider(this.name);
    const providerLevel = mergeCapabilities(builtIn, this.capabilities);
    const accountLevel = mergeCapabilities(providerLevel, account?.capabilities);
    return mergeCapabilities(accountLevel, this.modelCapabilities?.[model]);
  }

  /** Get all accounts (explicit + implicit) in priority order. */
  getAllAccounts(): Account[] {
    if (this.accounts.length > 0) {
      return this.accounts;
    }
    return [this.implicitAccount];
  }

  /**
   * Build Candidate objects for a given model.
   * Returns candidates in priority order: accounts sorted by priority.
   */
  getCandidatesForModel(model: string): Candidate[] {
    const accounts = this.getAccountsForModel(model);
    return accounts.map((acct) => ({
      provider: this.name,
      account: acct.name === '_implicit' ? null : acct.name,
      model,
    }));
  }
}

// ── Provider Registry ─────────────────────────────────────────

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();

  constructor(config: SaivageConfig) {
    this.initProviders(config);
  }

  private initProviders(config: SaivageConfig): void {
    for (const [name, entry] of Object.entries(config.providers)) {
      this.providers.set(name, new Provider(name, entry));
    }
  }

  /** Get a provider by name. */
  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  /** Get all providers sorted by priority (lower first). */
  getAll(): Provider[] {
    return Array.from(this.providers.values()).sort(
      (a, b) => a.priority - b.priority,
    );
  }

  /**
   * Get all providers that can serve a given model,
   * sorted by priority (lowest first).
   */
  getProvidersForModel(model: string): Provider[] {
    return this.getAll().filter((p) => p.canServe(model));
  }

  /** Compute effective capabilities for a concrete candidate. */
  getEffectiveCapabilities(candidate: Candidate): EffectiveProviderCapabilities {
    const provider = this.get(candidate.provider);
    if (!provider) return builtInCapabilitiesForProvider(candidate.provider);
    return provider.getEffectiveCapabilities(candidate.model, candidate.account);
  }
}
