import type { SaivageConfig } from './config-schema.js';
import { getModelListForRole } from '../config/model-role-resolution.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import { ProviderRegistry } from './provider.js';
import {
  supportsCapabilityRequest,
  type CapabilityRequest,
  type CapabilitySkipDiagnostic,
} from './provider-capabilities.js';

// ── Model Router ──────────────────────────────────────────────

/**
 * Resolves an agent role into an ordered chain of
 * provider/account/model candidates.
 */
export class ModelRouter {
  private registry: ProviderRegistry;
  private config: SaivageConfig;
  private lastCapabilitySkips: CapabilitySkipDiagnostic[] = [];

  constructor(config: SaivageConfig, registry: ProviderRegistry) {
    this.config = config;
    this.registry = registry;
  }

  /**
   * Resolve a role into the full configured/capability-compatible candidate route.
   *
   * The chain is built as follows:
   * 1. Iterate the role's configured model list in order.
   * 2. For each model, find providers that can serve it.
   * 3. Sort providers by priority.
   * 4. For each provider, sort accounts by priority.
   * 5. Produce provider/account/model candidates.
   * 6. For each configured base model, append its equivalence-group models and
   *    configured failover models after the base model. Process every configured
   *    base model for its own edges even if it was already emitted through an
   *    earlier route; deduplicate only emitted model batches/concrete candidates.
   *
   * This method is intentionally network-free and availability-free: it must not load or refresh
   * OAuth profiles during startup-time candidate resolution. Transport/auth
   * validation and live cooldown/block filtering happen later at real LLM invocation time.
   */
  async resolve(role: string, request?: CapabilityRequest): Promise<Candidate[]> {
    this.lastCapabilitySkips = [];
    const modelList = getModelListForRole(this.config, role);
    const candidates: Candidate[] = [];

    const equivalents = this.config.models.equivalents ?? [];
    const failover = this.config.models.failover ?? {};

    const emittedModelBatches = new Set<string>();
    const emittedCandidates = new Set<string>();

    for (const model of modelList) {
      this.appendModelCandidates(model, request, emittedModelBatches, emittedCandidates, candidates);

      const eqGroup = equivalents.find((group) => group.includes(model));
      if (eqGroup) {
        for (const eqModel of eqGroup) {
          if (eqModel === model) continue;
          this.appendModelCandidates(eqModel, request, emittedModelBatches, emittedCandidates, candidates);
        }
      }

      const chain = failover[model];
      if (chain) {
        for (const foModel of chain) {
          this.appendModelCandidates(foModel, request, emittedModelBatches, emittedCandidates, candidates);
        }
      }
    }

    return candidates;
  }

  /**
   * Resolve a single model to its capability-compatible candidates.
   * Providers sorted by priority, then accounts sorted by priority.
   */
  private resolveModel(model: string, request?: CapabilityRequest): Candidate[] {
    const candidates: Candidate[] = [];
    const providers = this.registry.getProvidersForModel(model);

    for (const provider of providers) {
      const acctCandidates = provider.getCandidatesForModel(model);
      for (const c of acctCandidates) {
        const match = supportsCapabilityRequest(
          this.registry.getEffectiveCapabilities(c),
          request,
        );
        if (!match.supported) {
          this.lastCapabilitySkips.push({ candidate: c, reasons: match.reasons });
          continue;
        }
        candidates.push(c);
      }
    }

    return candidates;
  }

  private appendModelCandidates(model: string, request: CapabilityRequest | undefined, emittedModelBatches: Set<string>, emittedCandidates: Set<string>, output: Candidate[]): void {
    if (emittedModelBatches.has(model)) return;
    emittedModelBatches.add(model);
    for (const candidate of this.resolveModel(model, request)) {
      const key = `${candidate.provider}\u0000${candidate.account ?? ''}\u0000${candidate.model}`;
      if (emittedCandidates.has(key)) continue;
      emittedCandidates.add(key);
      output.push(candidate);
    }
  }

  /** Return non-secret diagnostics for candidates skipped by the last resolve call. */
  getLastCapabilitySkips(): CapabilitySkipDiagnostic[] {
    return [...this.lastCapabilitySkips];
  }
}
