// Single source of truth lives in @agentbase/shared, guarded by a test that
// asserts it covers every eventType the API emits. This file exists only so
// existing imports keep working.
export {
  AUDIT_EVENT_TYPES as KNOWN_EVENTS,
  DEFAULT_WEBHOOK_EVENTS,
  type AuditEventType as KnownEvent,
} from '@agentbase/shared';
