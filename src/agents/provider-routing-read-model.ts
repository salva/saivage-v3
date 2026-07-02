import type { CandidateAvailability } from './candidate-availability.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import type { ProviderRegistry } from './provider.js';

export interface ProviderRoutingSummary {
  priority: number;
  models: string[];
  baseUrl?: string;
  accounts: string[];
  candidateCount: number;
  availableCandidateCount: number;
  capabilitiesByModel: Record<string, unknown>;
  availability: Record<string, { state: string; reason?: string; untilMs?: number }>;
}

export interface ProviderRoutingReadModel {
  providers: Record<string, ProviderRoutingSummary>;
}

function candidateId(candidate: Candidate): string {
  return `${candidate.provider}/${candidate.account ?? '_'}/${candidate.model}`;
}

export function buildProviderRoutingReadModel(input: {
  registry: ProviderRegistry;
  availability: CandidateAvailability;
}): ProviderRoutingReadModel {
  const providers: Record<string, ProviderRoutingSummary> = {};
  for (const provider of input.registry.getAll()) {
    const candidates = Array.from(provider.models).flatMap((model) => provider.getCandidatesForModel(model));
    const availability: ProviderRoutingSummary['availability'] = {};
    let availableCandidateCount = 0;
    for (const candidate of candidates) {
      if (input.availability.isAvailable(candidate)) availableCandidateCount += 1;
      const entry = input.availability.getEntry(candidate);
      availability[candidateId(candidate)] = entry
        ? { state: entry.state, ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.untilMs ? { untilMs: entry.untilMs } : {}) }
        : { state: 'HEALTHY' };
    }
    providers[provider.name] = {
      priority: provider.priority,
      models: Array.from(provider.models),
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      accounts: provider.getAllAccounts().map((account) => account.name),
      candidateCount: candidates.length,
      availableCandidateCount,
      capabilitiesByModel: Object.fromEntries(Array.from(provider.models).map((model) => [model, provider.getEffectiveCapabilities(model, null)])),
      availability,
    };
  }
  return { providers };
}
