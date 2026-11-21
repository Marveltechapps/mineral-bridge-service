import { describe, expect, it } from 'vitest';
import { signRegistrationToken, verifyRegistrationToken } from './v2.registration-token.js';

describe('v2 registration token', () => {
  it('round-trips claims', () => {
    const { token, expiresIn } = signRegistrationToken({
      dest: '+2348034127790',
      channel: 'whatsapp',
      cli: 'mobile',
      fullName: 'Adaeze Okafor',
    });
    expect(expiresIn).toBe(600);
    const verified = verifyRegistrationToken(token);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims.dest).toBe('+2348034127790');
    expect(verified.claims.channel).toBe('whatsapp');
    expect(verified.claims.cli).toBe('mobile');
    expect(verified.claims.fullName).toBe('Adaeze Okafor');
  });

  it('rejects garbage', () => {
    expect(verifyRegistrationToken('not-a-jwt').ok).toBe(false);
  });
});
