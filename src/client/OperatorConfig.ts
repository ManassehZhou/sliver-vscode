/**
 * Sliver operator config — the JSON ".cfg" produced by `new-operator` on the
 * server. Every field is sensitive (certs/keys/token), so the whole object is
 * stored in VSCode SecretStorage.
 */
export interface OperatorConfig {
  operator: string;
  lhost: string;
  lport: number;
  ca_certificate: string;
  certificate: string;
  private_key: string;
  token: string;
}

const REQUIRED_STRING_FIELDS: (keyof OperatorConfig)[] = [
  'operator',
  'lhost',
  'ca_certificate',
  'certificate',
  'private_key',
  'token',
];

export class ConfigParseError extends Error {}

/**
 * Parse and strictly validate a raw .cfg file. Throws ConfigParseError with a
 * human-readable message on any problem. Pure — unit-tested without a server.
 */
export function parseOperatorConfig(raw: string): OperatorConfig {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new ConfigParseError(`Not valid JSON: ${(err as Error).message}`);
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new ConfigParseError('Config must be a JSON object');
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    const val = obj[field];
    if (typeof val !== 'string' || val.length === 0) {
      throw new ConfigParseError(`Missing or empty field: "${field}"`);
    }
  }

  const lport = Number(obj.lport);
  if (!Number.isInteger(lport) || lport <= 0 || lport > 65535) {
    throw new ConfigParseError(`Invalid "lport": ${obj.lport}`);
  }

  for (const [field, label] of [
    ['ca_certificate', 'CERTIFICATE'],
    ['certificate', 'CERTIFICATE'],
    ['private_key', 'PRIVATE KEY'],
  ] as const) {
    if (!obj[field].includes(`-----BEGIN`) || !obj[field].includes(label)) {
      throw new ConfigParseError(`Field "${field}" does not look like a PEM ${label}`);
    }
  }

  return {
    operator: obj.operator,
    lhost: obj.lhost,
    lport,
    ca_certificate: obj.ca_certificate,
    certificate: obj.certificate,
    private_key: obj.private_key,
    token: obj.token,
  };
}

/** Stable id for a config, used as the key in SecretStorage / globalState. */
export function connectionId(config: Pick<OperatorConfig, 'operator' | 'lhost' | 'lport'>): string {
  return `${config.operator}@${config.lhost}:${config.lport}`;
}
