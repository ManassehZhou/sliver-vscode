import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOperatorConfig, ConfigParseError, connectionId } from '../../src/client/OperatorConfig';

const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
const CERT = '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----';

const valid = {
  operator: 'neo',
  lhost: '10.0.0.1',
  lport: 31337,
  ca_certificate: CA,
  certificate: CERT,
  private_key: KEY,
  token: 'deadbeef',
};

test('parses a valid config', () => {
  const cfg = parseOperatorConfig(JSON.stringify(valid));
  assert.equal(cfg.operator, 'neo');
  assert.equal(cfg.lport, 31337);
  assert.equal(cfg.token, 'deadbeef');
});

test('coerces stringified lport', () => {
  const cfg = parseOperatorConfig(JSON.stringify({ ...valid, lport: '443' }));
  assert.equal(cfg.lport, 443);
});

test('rejects invalid JSON', () => {
  assert.throws(() => parseOperatorConfig('{not json'), ConfigParseError);
});

test('rejects missing field', () => {
  const { token, ...rest } = valid;
  void token;
  assert.throws(() => parseOperatorConfig(JSON.stringify(rest)), /token/);
});

test('rejects bad port', () => {
  assert.throws(() => parseOperatorConfig(JSON.stringify({ ...valid, lport: 0 })), /lport/);
  assert.throws(() => parseOperatorConfig(JSON.stringify({ ...valid, lport: 99999 })), /lport/);
});

test('rejects non-PEM private key', () => {
  assert.throws(
    () => parseOperatorConfig(JSON.stringify({ ...valid, private_key: 'oops' })),
    /private_key/,
  );
});

test('connectionId is stable', () => {
  assert.equal(connectionId(valid), 'neo@10.0.0.1:31337');
});
