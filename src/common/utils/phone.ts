const E164 = /^\+[1-9]\d{6,14}$/;
const NIGERIAN_MOBILE = /^\+234[789]\d{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Strips spaces, dashes and parentheses; returns an E.164 string or null. */
export function normalizePhone(input: string): string | null {
  const cleaned = input.trim().replace(/[\s\-().]/g, '');
  return E164.test(cleaned) ? cleaned : null;
}

/** Mobile contract: `auth/invalid-phone` = "Not a valid Nigerian mobile number". */
export function isNigerianMobile(e164: string): boolean {
  return NIGERIAN_MOBILE.test(e164);
}

export function normalizeEmail(input: string): string | null {
  const cleaned = input.trim().toLowerCase();
  return cleaned.length <= 254 && EMAIL.test(cleaned) ? cleaned : null;
}

/** `+2348024419087` → `+234 802 441 ••87`; other countries → `+27 82 ••• 0000`. */
export function maskPhone(e164: string): string {
  if (e164.startsWith('+234') && e164.length === 14) {
    return `+234 ${e164.slice(4, 7)} ${e164.slice(7, 10)} ••${e164.slice(-2)}`;
  }
  if (e164.length < 9) return '••••';
  return `${e164.slice(0, 3)} ${e164.slice(3, 5)} ••• ${e164.slice(-4)}`;
}

/** `adaeze@example.com` → `a•••@example.com` */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

/** Masks the last IPv4 octet / trailing IPv6 groups for session lists. */
export function maskIp(ip: string | undefined | null): string {
  if (!ip) return '';
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return `${parts.slice(0, Math.max(1, parts.length - 4)).join(':')}:••••`;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;
  return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
}
