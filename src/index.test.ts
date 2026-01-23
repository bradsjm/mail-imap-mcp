import { describe, expect, it } from 'vitest';
import { scrubSecrets } from './index.js';

describe('scrubSecrets', () => {
  it('redacts secret-ish keys recursively', () => {
    const value = scrubSecrets({
      password: 'p',
      token: 't',
      nested: { authorization: 'bearer', ok: 123 },
      list: [{ secret: 's' }],
    });

    expect(value).toEqual({
      password: '[REDACTED]',
      token: '[REDACTED]',
      nested: { authorization: '[REDACTED]', ok: 123 },
      list: [{ secret: '[REDACTED]' }],
    });
  });
});
