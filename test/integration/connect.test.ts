/**
 * Integration smoke test against a real sliver-server.
 *
 * Skipped unless SLIVER_CFG points at an operator .cfg file:
 *   SLIVER_CFG=./dev.cfg node --test --import tsx ./test/integration/connect.test.ts
 *
 * Validates the highest-risk path: mTLS + bearer-token auth via a GetVersion
 * handshake, plus listing sessions/beacons/jobs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { parseOperatorConfig } from '../../src/client/OperatorConfig';
import { SliverClient } from '../../src/client/SliverClient';

const cfgPath = process.env.SLIVER_CFG;

test('connects, handshakes, and lists state', { skip: !cfgPath }, async () => {
  const config = parseOperatorConfig(fs.readFileSync(cfgPath!, 'utf8'));
  const client = new SliverClient(config);
  try {
    const version = await client.connect();
    assert.ok(version.Major >= 1, 'server version major >= 1');

    const sessions = await client.getSessions();
    const beacons = await client.getBeacons();
    const jobs = await client.getJobs();
    assert.ok(Array.isArray(sessions.Sessions));
    assert.ok(Array.isArray(beacons.Beacons));
    assert.ok(Array.isArray(jobs.Active));
  } finally {
    client.disconnect();
  }
});
