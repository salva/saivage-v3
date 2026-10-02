import { ServerEgressWsEnvelopeSchema, type ServerEgressWsEnvelope } from '../contracts/index.js';

export function projectWsEnvelopeForOutbound(
  envelope: ServerEgressWsEnvelope,
): ServerEgressWsEnvelope {
  return ServerEgressWsEnvelopeSchema.parse(envelope);
}
