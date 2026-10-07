import { materializeConversationImage } from '../persistence/session-api.js';
import {
  assertProviderConversationSourceRows,
  providerItemImageDescriptors,
  type ProviderConversationProjection,
  type ProviderConversationItem,
} from '../contracts/index.js';

/** Resolve only the selected uncovered results, under their original source session. */
export async function materializeProviderConversation(
  projectRoot: string,
  projection: ProviderConversationProjection,
  signal?: AbortSignal,
): Promise<ProviderConversationProjection> {
  assertProviderConversationSourceRows(projection);
  if (projection.sourceSessionId === null) return projection;
  const sourceSessionId = projection.sourceSessionId;
  const messages: ProviderConversationItem[] = [];
  for (const item of projection.messages) {
    signal?.throwIfAborted();
    if (item.kind === 'synthetic_context') {
      messages.push(item);
      continue;
    }
    const descriptor = providerItemImageDescriptors(item)[0];
    if (!descriptor) {
      messages.push(item);
      continue;
    }
    const image = await materializeConversationImage(projectRoot, sourceSessionId, descriptor);
    signal?.throwIfAborted();
    messages.push({
      ...item,
      image,
    });
  }
  signal?.throwIfAborted();
  return { sourceSessionId, messages };
}
