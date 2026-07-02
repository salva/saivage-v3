import type { SaivageConfig } from './config-schema.js';
import { getModelListForRole } from './config-schema.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import { ProviderRegistry } from './provider.js';
import { type CandidateAvailability, MemoryCandidateAvailability } from './candidate-availability.js';
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
  private availability: CandidateAvailability;
  private lastCapabilitySkips: CapabilitySkipDiagnostic[] = [];

  constructor(
    config: SaivageConfig,
    registry: ProviderRegistry,
    availability: CandidateAvailability = new MemoryCandidateAvailability(),
  ) {
    this.config = config;
    this.registry = registry;
    this.availability = availability;
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
   *
   * This method is intentionally network-free: it must not load or refresh
   * OAuth profiles during startup-time candidate resolution. Transport/auth
   * validation happens later at real LLM invocation time.
   */
  async resolve(role: string, request?: CapabilityRequest): Promise<Candidate[]> {
    this.lastCapabilitySkips = [];
    const modelList = getModelListForRole(this.config, role);
    const candidates: Candidate[] = [];

    const equivalents = this.config.models.equivalents ?? [];
    const failover = this.config.models.failover ?? {};

    const seenModels = new Set<string>();

    for (const model of modelList) {
      if (seenModels.has(model)) continue;
      seenModels.add(model);

      const modelCandidates = this.resolveModel(model, request);
      candidates.push(...modelCandidates);

      if (modelCandidates.length > 0) continue;

      const eqGroup = equivalents.find((group) => group.includes(model));
      if (eqGroup) {
        for (const eqModel of eqGroup) {
          if (eqModel === model || seenModels.has(eqModel)) continue;
          seenModels.add(eqModel);
          const eqCandidates = this.resolveModel(eqModel, request);
          if (eqCandidates.length > 0) {
            candidates.push(...eqCandidates);
            break;
          }
        }
      }

      const chain = failover[model];
      if (chain) {
        for (const foModel of chain) {
          if (seenModels.has(foModel)) continue;
          seenModels.add(foModel);
          const foCandidates = this.resolveModel(foModel, request);
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
   * Resolve a single model to its healthy and capability-compatible candidates.
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
        if (!this.availability.isAvailable(c)) continue;
        candidates.push(c);
      }
    }

    return candidates;
  }

  /** Return non-secret diagnostics for candidates skipped by the last resolve call. */
  getLastCapabilitySkips(): CapabilitySkipDiagnostic[] {
    return [...this.lastCapabilitySkips];
  }
}
