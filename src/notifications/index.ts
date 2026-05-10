/**
 * Notifications module — re-exports the NotificationRouter, its types,
 * utility functions, and the factory.
 */

export {
  NotificationRouter,
  createNotificationRouter,
  shouldSend,
  notificationToEnvelope,
  SEVERITY_ORDER,
} from './notification-router.js';

export type {
  NotificationEvent,
  NotificationFilter,
  NotificationConfig,
  SeverityLevel,
  ChannelHandler,
} from './notification-router.js';
