export function scrubSecrets(value: unknown): unknown {
  const secretKeyPattern = /(pass(word)?|token|secret|authorization|cookie|key)/i;

  if (Array.isArray(value)) {
    return value.map((item) => scrubSecrets(item));
  }

  if (value && typeof value === 'object') {
    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      record[k] = secretKeyPattern.test(k) ? '[REDACTED]' : scrubSecrets(v);
    }
    return record;
  }

  return value;
}
