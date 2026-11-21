import type { Request, Response } from 'express';
import { clientIp, noStore } from './auth.http.js';
import { getUserContext } from './auth.middleware.js';
import {
  confirmContactChange,
  getHomeSummary,
  getMe,
  getNotificationPreferences,
  patchMe,
  patchNotificationPreferences,
  startContactChange,
  updateBusinessType,
} from './v2.me.service.js';

function clientOf(req: Request): 'mobile' | 'web' {
  return req.apiClient === 'mobile' ? 'mobile' : 'web';
}

export async function meGet(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  res.status(200).json(await getMe(user.id));
}

export async function mePatch(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const body = req.body as { fullName?: string; businessName?: string; countryCode?: string };
  res.status(200).json(await patchMe(user.id, body));
}

export async function contactChangeStart(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const body = req.body as { channel: 'whatsapp' | 'sms' | 'email'; identifier: string };
  const info = await startContactChange({
    userId: user.id,
    client: clientOf(req),
    channel: body.channel,
    identifier: body.identifier,
    ip: clientIp(req),
  });
  noStore(res);
  res.status(202).json({
    challengeId: info.challengeId,
    maskedDestination: info.maskedDestination,
    ...(info.developmentOtp ? { developmentOtp: info.developmentOtp } : {}),
    ...(info.resendAvailableAt ? { resendAvailableAt: info.resendAvailableAt } : {}),
  });
}

export async function contactChangeVerify(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const body = req.body as { challengeId: string; code: string };
  const me = await confirmContactChange({
    userId: user.id,
    client: clientOf(req),
    challengeId: body.challengeId,
    code: body.code,
  });
  res.status(200).json(me);
}

export async function businessTypePut(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  const body = req.body as {
    role: 'buyer' | 'seller' | 'both';
    buyerType?: import('../users/user.types.js').BuyerType;
    sellerType?: import('../users/user.types.js').SellerType;
    businessName?: string;
  };
  res.status(200).json(await updateBusinessType(user.id, body));
}

export async function summaryGet(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  res.status(200).json(await getHomeSummary(user.id));
}

export async function prefsGet(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  res.status(200).json(await getNotificationPreferences(user.id));
}

export async function prefsPatch(req: Request, res: Response): Promise<void> {
  const { user } = getUserContext(req);
  res.status(200).json(await patchNotificationPreferences(user.id, req.body));
}
