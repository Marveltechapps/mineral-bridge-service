import { describe, expect, it } from 'vitest';
import { webRefreshCookieOptions } from '../src/modules/auth/auth.cookies.js';

describe('web refresh cookie persistence', () => {
  it('keeps the existing refresh lifetime when the user stays signed in', () => {
    const options = webRefreshCookieOptions(true);
    expect(options.httpOnly).toBe(true);
    expect(options.maxAge).toBeGreaterThan(0);
    expect(options.path).toBe('/v1/auth');
  });

  it('omits Max-Age for a browser session when keep-me-signed-in is off', () => {
    const options = webRefreshCookieOptions(false);
    expect(options.maxAge).toBeUndefined();
    expect(options.httpOnly).toBe(true);
    expect(options.path).toBe('/v1/auth');
  });
});
