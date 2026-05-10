/**
 * Server module — public API surface.
 *
 * Modules:
 *   server.ts     — Fastify instance, /health, startServer/stopServer
 *   auth.ts       — SAIVAGE_API_TOKEN auth plugin
 *   routes/       — REST endpoint route registrations
 *   websocket.ts  — WebSocket endpoint and event bus wiring
 */

export { createServer, startServer, stopServer, getServerConfig } from './server.js';
export type { ServerConfig, ServerInstance } from './server.js';

export { default as authPlugin } from './auth.js';
export type { AuthPluginOptions } from './auth.js';

export { registerCardRoutes } from './routes/cards.js';
export { registerRuntimeConfigNotesRoutes } from './routes/runtime-config-notes.js';
export { registerChatsFilesDebugRoutes } from './routes/chats-files-debug.js';

export {
  registerWebSocket,
  broadcast,
  sendToClient,
  getClientCount,
  wireRuntimeEvents,
  createRuntimeEnvelope,
} from './websocket.js';
export type { WsEnvelope, WsEventType } from './websocket.js';
