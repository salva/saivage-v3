import type { SaivageConfig } from '../schemas/saivage-config.js';

export function getModelListForAgent(config: SaivageConfig, agentName: string): string[] {
  const agent = config.agents[agentName];
  if (!agent) throw new Error(`Unknown agent '${agentName}'.`);
  const route = config.models.routes[agent.model_route];
  if (!route) throw new Error(`Unknown model route '${agent.model_route}'.`);
  if (route.candidates) return [...route.candidates];
  const profile = config.models.profiles[route.profile!];
  if (!profile) throw new Error(`Unknown model profile '${route.profile}'.`);
  const candidates = [...profile.preferred, ...profile.allowed];
  if (candidates.length === 0) throw new Error(`Model route '${agent.model_route}' resolves to no candidates.`);
  return candidates;
}
