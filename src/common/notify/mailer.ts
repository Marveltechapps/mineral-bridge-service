import { AppError } from '../errors/app-error.js';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export type SentMail = { to: string; subject: string; text: string; at: Date };
export const fakeMailOutbox: SentMail[] = [];

/** Transactional email. `fake` is dev/test only; `smtp` requires an SMTP transport (not bundled) → 503. */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const env = loadEnv();
  if (env.EMAIL_PROVIDER === 'fake') {
    if (env.NODE_ENV === 'production') {
      throw new AppError({ status: 503, code: 'email/provider-unconfigured', message: 'Email provider is not configured' });
    }
    fakeMailOutbox.push({ to, subject, text, at: new Date() });
    if (fakeMailOutbox.length > 200) fakeMailOutbox.shift();
    if (env.NODE_ENV === 'development') logger.info({ to, subject }, '[fake-mail]');
    return;
  }
  throw new AppError({
    status: 503,
    code: 'email/provider-unconfigured',
    message: 'SMTP transport is not bundled in this build; plug a mail provider into src/common/notify/mailer.ts',
  });
}
