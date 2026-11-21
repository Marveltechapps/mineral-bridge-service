import type { Request, Response } from 'express';
import { unauthorized } from '../../common/errors/app-error.js';
import { revokeStaffSession, rotateStaffSession, syncStaffCsrf } from '../sessions/session.service.js';
import { clearAdminSessionCookie, setAdminSessionCookie } from './auth.cookies.js';
import { clientIp, deviceFromRequest, noStore } from './auth.http.js';
import { getStaffContext } from './auth.middleware.js';
import {
  buildMe,
  challengeBody,
  completeSso,
  confirmPasswordReset,
  lockConsole,
  requestPasswordReset,
  resendSignInOtp,
  signIn,
  startSso,
  unlockConsole,
  verifySignInOtp,
} from './admin.auth.service.js';

// #1 POST /auth/sign-in
export async function signInHandler(req: Request, res: Response): Promise<void> {
  const b = req.body as { email: string; password: string; returnTo?: string };
  const { issued, staff, redirectTo } = await signIn({ ...b, ip: clientIp(req), device: deviceFromRequest(req) });
  setAdminSessionCookie(res, issued.sessionToken, req);
  res.setHeader('X-CSRF-Token', issued.csrfToken);
  noStore(res);
  res.status(200).json({ me: buildMe(staff, issued.session, issued.csrfToken), redirectTo });
}

// #2 POST /auth/sso/start
export async function ssoStart(req: Request, res: Response): Promise<void> {
  const b = req.body as { email: string; returnTo?: string };
  res.status(200).json(startSso(b));
}

// #3 POST /auth/sso/callback — continues into the same 2FA challenge as password sign-in
export async function ssoCallback(req: Request, res: Response): Promise<void> {
  const b = req.body as { code: string; state: string };
  const info = await completeSso({ ...b, ip: clientIp(req) });
  noStore(res);
  res.status(200).json(challengeBody(info));
}

// #4 POST /auth/otp/verify
export async function otpVerify(req: Request, res: Response): Promise<void> {
  const b = req.body as { challengeId: string; code: string };
  const { issued, staff, redirectTo } = await verifySignInOtp({ ...b, device: deviceFromRequest(req) });
  setAdminSessionCookie(res, issued.sessionToken, req);
  res.setHeader('X-CSRF-Token', issued.csrfToken);
  noStore(res);
  res.status(200).json({ me: buildMe(staff, issued.session, issued.csrfToken), redirectTo });
}

// #5 POST /auth/otp/resend
export async function otpResend(req: Request, res: Response): Promise<void> {
  const b = req.body as { challengeId: string };
  const info = await resendSignInOtp({ challengeId: b.challengeId, ip: clientIp(req) });
  noStore(res);
  res.status(200).json({
    maskedDestination: info.maskedDestination,
    resendAvailableAt: info.resendAvailableAt.toISOString(),
    ...(info.developmentOtp ? { developmentOtp: info.developmentOtp } : {}),
  });
}

// #6 POST /auth/password-reset — always 202; a signed-in caller may omit the email
export async function passwordReset(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { email?: string };
  const email = body.email ?? (req.actor?.kind === 'staff' ? await sessionEmail(req) : undefined);
  if (email) await requestPasswordReset({ email, ip: clientIp(req), origin: requestOrigin(req) });
  res.status(202).json({ message: 'If that account exists, a reset link is on its way.' });
}

async function sessionEmail(req: Request): Promise<string | undefined> {
  try {
    return getStaffContext(req).staff.email;
  } catch {
    return undefined;
  }
}

/** Origin of the dashboard that asked for the link, so the email opens that host. */
function requestOrigin(req: Request): string | undefined {
  const origin = req.get('origin');
  if (origin) return origin;
  const referer = req.get('referer');
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

// #7 POST /auth/password-reset/confirm
export async function passwordResetConfirm(req: Request, res: Response): Promise<void> {
  const b = req.body as { token: string; newPassword: string };
  await confirmPasswordReset(b);
  res.status(204).end();
}

// #8 POST /auth/refresh — rotates cookie + CSRF, slides idle deadline
export async function refresh(req: Request, res: Response): Promise<void> {
  const { session } = getStaffContext(req);
  const rotated = await rotateStaffSession(session);
  if (!rotated) throw unauthorized('auth/session-expired', 'Your session has expired. Sign in again.');
  setAdminSessionCookie(res, rotated.sessionToken, req);
  res.setHeader('X-CSRF-Token', rotated.csrfToken);
  res.status(204).end();
}

// #9 POST /auth/lock
export async function lock(req: Request, res: Response): Promise<void> {
  const { session } = getStaffContext(req);
  const lockedAt = await lockConsole(session);
  res.status(200).json({ lockedAt: lockedAt.toISOString() });
}

// #10 POST /auth/unlock
export async function unlock(req: Request, res: Response): Promise<void> {
  const { staff, session, sessionToken } = getStaffContext(req);
  const { password } = req.body as { password: string };
  const unlocked = await unlockConsole({ staff, session, password });
  const csrfToken = await syncStaffCsrf(unlocked, sessionToken);
  noStore(res);
  res.status(200).json({ me: buildMe(staff, unlocked, csrfToken) });
}

// #11 POST /auth/sign-out
export async function signOut(req: Request, res: Response): Promise<void> {
  const { session } = getStaffContext(req);
  await revokeStaffSession(session.id, 'sign_out');
  clearAdminSessionCookie(res, req);
  res.status(204).end();
}

// #12 GET /me — re-issues the CSRF token so a reloaded tab can recover it from the cookie.
// syncStaffCsrf keeps the stored hash on the current secret before the token is returned.
export async function me(req: Request, res: Response): Promise<void> {
  const { staff, session, sessionToken } = getStaffContext(req);
  const csrfToken = await syncStaffCsrf(session, sessionToken);
  res.setHeader('X-CSRF-Token', csrfToken);
  noStore(res);
  res.status(200).json(buildMe(staff, session, csrfToken));
}
