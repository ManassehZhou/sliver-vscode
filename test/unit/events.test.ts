import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventType, SESSION_EVENTS, BEACON_EVENTS, JOB_EVENTS } from '../../src/client/events';

test('session events are categorized', () => {
  assert.ok(SESSION_EVENTS.includes(EventType.SessionConnected));
  assert.ok(SESSION_EVENTS.includes(EventType.SessionDisconnected));
  assert.ok(!SESSION_EVENTS.includes(EventType.JobStopped));
});

test('beacon events are categorized', () => {
  assert.ok(BEACON_EVENTS.includes(EventType.BeaconRegistered));
  assert.ok(!BEACON_EVENTS.includes(EventType.SessionConnected));
});

test('job events are categorized', () => {
  assert.ok(JOB_EVENTS.includes(EventType.JobStarted));
  assert.ok(JOB_EVENTS.includes(EventType.JobStopped));
});

test('event type string values match the server', () => {
  assert.equal(EventType.SessionConnected, 'session-connected');
  assert.equal(EventType.BeaconRegistered, 'beacon-registered');
  assert.equal(EventType.JobStopped, 'job-stopped');
});
