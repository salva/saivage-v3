import type { Candidate } from '../contracts/provider-candidate.js';
import { ProviderRegistry } from './provider.js';
import {
  supportsCapabilityRequest,
  type CapabilityRequest,
} from './provider-capabilities.js';

// ── Model Router ──────────────────────────────────────────────

/**
 * Resolves explicit model IDs into provider/account/model candidates.
 */
export class ModelRouter {
  private readonly registry: ProviderRegistry;

  constructor(registry: ProviderRegistry) {
    this.registry = registry;
  }

  /**
   * Resolve the already-expanded explicit model order into concrete candidates.
   *
   * The chain is built as follows:
   * 1. Iterate the caller's explicit model IDs in order.
   * 2. For each model, find providers that can serve it.
   * 3. Sort providers by priority.
   * 4. For each provider, sort accounts by priority.
   * 5. Produce provider/account/model candidates.
   * Structural route/profile/equivalence/failover expansion has already happened;
   * this resolver deduplicates only concrete candidates.
   *
   * This method is intentionally network-free and availability-free: it must not load or refresh
   * OAuth profiles during startup-time candidate resolution. Transport/auth
   * validation and live cooldown/block filtering happen later at real LLM invocation time.
   */
  resolveModels(orderedModelIds: readonly string[], request: CapabilityRequest): Candidate[] {
    const candidates: Candidate[] = [];
    const emittedCandidates = new Set<string>();
    for (const model of orderedModelIds)
      for (const candidate of this.resolveModel(model, request)) {
        const key = `${candidate.provider}\u0000${candidate.account ?? ''}\u0000${candidate.model}`;
        if (!emittedCandidates.has(key)) { emittedCandidates.add(key); candidates.push(candidate); }
      }
    return candidates;
  }

  /**
   * Resolve a single model to its capability-compatible candidates.
   * Providers sorted by priority, then accounts sorted by priority.
   */
  private resolveModel(model: string, request: CapabilityRequest): Candidate[] {
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
          continue;
        }
        candidates.push(c);
      }
    }

    return candidates;
  }

}
