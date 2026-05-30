/**
 * Sliver server event type strings (the `EventType` field of clientpb.Event).
 * Mirrors the constants in the Sliver server's core/events.go.
 */
export const EventType = {
  Joined: 'client-joined',
  Left: 'client-left',
  SessionConnected: 'session-connected',
  SessionUpdated: 'session-updated',
  SessionDisconnected: 'session-disconnected',
  BeaconRegistered: 'beacon-registered',
  BeaconTaskResult: 'beacon-taskresult',
  JobStarted: 'job-started',
  JobStopped: 'job-stopped',
  Build: 'build',
  BuildCompleted: 'build-completed',
  Canary: 'canary',
  Watchtower: 'watchtower',
  Loot: 'loot',
} as const;

/** Events that mean the session list changed. */
export const SESSION_EVENTS: readonly string[] = [
  EventType.SessionConnected,
  EventType.SessionUpdated,
  EventType.SessionDisconnected,
];

/** Events that mean the beacon list changed. */
export const BEACON_EVENTS: readonly string[] = [
  EventType.BeaconRegistered,
  EventType.BeaconTaskResult,
];

/** Events that mean the job/listener list changed. */
export const JOB_EVENTS: readonly string[] = [EventType.JobStarted, EventType.JobStopped];
