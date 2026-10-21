import { loadEnv } from '../../config/env.js';

/**
 * Customer and staff OTP display. This is not developer login.
 * Production cannot satisfy the check, including when the flag is set.
 */
export function isDevelopmentOtpEnabled(env = loadEnv()): boolean {
  return env.NODE_ENV === 'development' && env.DEV_OTP_ENABLED === true;
}
