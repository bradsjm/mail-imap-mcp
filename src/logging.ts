/**
 * Recursively redact sensitive values from an object or array.
 *
 * Scans through nested objects and arrays, replacing values for keys that match
 * secret-related patterns (e.g., 'password', 'token', 'secret', 'authorization',
 * 'cookie', 'key') with '[REDACTED]'. This is used to prevent sensitive data
 * from appearing in logs.
 *
 * @example
 * ```ts
 * const input = { user: 'john', password: 'secret123', token: 'abc123' };
 * scrubSecrets(input);
 * // Returns: { user: 'john', password: '[REDACTED]', token: '[REDACTED]' }
 * ```
 *
 * @param value - The value to sanitize (object, array, or primitive)
 * @returns The sanitized value with secrets redacted
 */
export function scrubSecrets(value: unknown): unknown {
  // Pattern to identify keys that likely contain sensitive data
  // Matches variations of password, token, secret, auth, cookie, and key (case-insensitive)
  const secretKeyPattern = /(pass(word)?|token|secret|authorization|cookie|key)/i;

  // Recursively process arrays by applying scrubSecrets to each element
  if (Array.isArray(value)) {
    return value.map((item) => scrubSecrets(item));
  }

  // Recursively process objects by checking each key
  // If the key matches the secret pattern, redact the value
  // Otherwise, recursively scrub the value itself
  if (value && typeof value === 'object') {
    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      record[k] = secretKeyPattern.test(k) ? '[REDACTED]' : scrubSecrets(v);
    }
    return record;
  }

  return value;
}
