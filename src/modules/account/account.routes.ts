import { Router } from 'express';
import { z } from 'zod';
import { currentUser, currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { conflict } from '../../common/errors/app-error.js';
import { validate } from '../../common/middleware/validate.js';
import { mobileMoney } from '../../common/utils/currency.js';
import { iso } from '../../common/utils/time-display.js';
import { AuctionModel, BidModel } from '../../models/auction.model.js';
import { OrderModel } from '../../models/order.model.js';
import { SellRequestModel } from '../../models/sell.model.js';
import { SupportTicketModel } from '../../models/support.model.js';
import { references } from '../../common/utils/references.js';
import { requireUser } from '../auth/auth.middleware.js';
import { userRepository } from '../users/user.repository.js';
import * as users from '../users/user.service.js';
import { TIER_LABELS, type Tier, type UserAddress, type UserRecord } from '../users/user.types.js';
import { payoutsService, walletService } from '../payouts/payouts.service.js';
import { toWebPayoutMethod } from '../payouts/payouts.routes.js';
import { createAccountBody, idParam as payoutIdParam, patchAccountBody } from '../payouts/payouts.validation.js';
import { uploadsService } from '../uploads/uploads.service.js';

/* -- validation -------------------------------------------------------------------------- */

const profileBody = z
  .object({
    fullName: z.string().trim().min(1).max(160).optional(),
    displayName: z.string().trim().max(120).optional(),
    email: z.string().email().nullable().optional(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    phone: z.string().max(20).optional(),
    companyName: z.string().max(160).nullable().optional(),
    businessRegistrationNumber: z.string().max(60).nullable().optional(),
    countryCode: z.string().length(2).optional(),
  })
  .strict();

const avatarBody = z.object({ fileId: z.string().min(1) });
const tierBody = z.object({ tierId: z.number().int().min(1).max(3) });
const preferencesBody = z.object({
  language: z.enum(['en', 'ha', 'yo', 'ig', 'fr']).optional(),
  currency: z.enum(['USD', 'NGN', 'EUR', 'GBP']).optional(),
  units: z.enum(['metric', 'imperial']).optional(),
  alerts: z.object({ bids: z.boolean().optional(), orders: z.boolean().optional(), lots: z.boolean().optional(), marketing: z.boolean().optional() }).optional(),
  biometric: z.boolean().optional(),
});
const addressBody = z.object({
  kind: z.enum(['pickup', 'delivery']).default('delivery'),
  label: z.string().min(1).max(120),
  streetAddress: z.string().min(1).max(240),
  city: z.string().min(1).max(120),
  region: z.string().min(1).max(120),
  country: z.string().length(2).default('NG'),
  contactPerson: z.string().max(120).optional(),
  contactPhone: z.string().max(20).optional(),
  isDefault: z.boolean().default(false),
  importPermitNumber: z.string().max(60).optional(),
});
const addressPatch = addressBody.partial();
const addressParam = z.object({ addressId: z.string().min(1) });

/* -- mappers ----------------------------------------------------------------------------- */

const mobileProfile = (u: UserRecord) => ({
  id: u.id,
  phone: u.phone ?? null,
  email: u.email ?? null,
  fullName: u.profile.fullName ?? null,
  displayName: u.profile.displayName ?? u.profile.fullName ?? null,
  initials: users.initialsOf(u.profile.fullName ?? u.profile.displayName ?? u.email ?? u.phone),
  avatarUrl: u.profile.avatarUrl ?? null,
  dateOfBirth: u.profile.dateOfBirth ?? null,
  companyName: u.profile.companyName ?? null,
  businessRegistrationNumber: u.profile.businessRegistrationNumber ?? null,
  countryCode: u.profile.countryCode ?? null,
  roles: u.roles,
  tier: { id: u.tier, ...TIER_LABELS[u.tier] },
  kycStatus: u.kycStatus,
  lockedFields: users.lockedFieldsFor(u),
  memberSince: iso(u.createdAt),
});

const webProfile = (u: UserRecord) => ({
  id: u.id,
  fullName: u.profile.fullName ?? null,
  displayName: u.profile.displayName ?? null,
  email: u.email ?? null,
  emailVerified: Boolean(u.emailVerifiedAt),
  phone: u.phone ?? null,
  phoneVerified: Boolean(u.phoneVerifiedAt),
  avatarUrl: u.profile.avatarUrl ?? null,
  company: u.profile.companyName ?? null,
  countryCode: u.profile.countryCode ?? null,
  roles: u.roles,
  kycStatus: users.toWebKycStatus(u.kycStatus),
  lockedFields: users.lockedFieldsFor(u),
  createdAt: iso(u.createdAt),
});

const address = (a: UserAddress) => ({
  id: a.id,
  kind: a.kind,
  label: a.label,
  streetAddress: a.streetAddress,
  city: a.city,
  region: a.region,
  country: a.country,
  contactPerson: a.contactPerson ?? null,
  contactPhone: a.contactPhone ?? null,
  isDefault: a.isDefault,
  importPermitNumber: a.importPermitNumber ?? null,
});

async function setAvatar(userId: string, fileId: string): Promise<UserRecord> {
  const f = await uploadsService.owned(userId, fileId);
  if (!f.contentType.startsWith('image/')) throw conflict('upload/not-an-image', 'The avatar must be an image.');
  const url = uploadsService.signed(f._id).url;
  const updated = await userRepository.update(userId, { $set: { 'profile.avatarUrl': url } });
  return updated ?? (await users.getUserOrThrow(userId));
}

/* -- mobile /me ------------------------------------------------------------------------ */

export function mobileAccountRouter(): Router {
  const r = Router();

  r.get('/me', requireUser, ah(async (req, res) => res.json(mobileProfile(await users.getUserOrThrow(currentUserId(req))))));
  r.patch('/me', requireUser, validate({ body: profileBody }), ah(async (req, res) => res.json(mobileProfile(await users.updateProfile(currentUserId(req), req.body)))));
  r.put('/me/avatar', requireUser, validate({ body: avatarBody }), ah(async (req, res) => res.json(mobileProfile(await setAvatar(currentUserId(req), req.body.fileId)))));

  r.get('/me/stats', requireUser, ah(async (req, res) => {
    const userId = currentUserId(req);
    const [ordersTotal, ordersActive, sellRequests, bidsPlaced, wallet] = await Promise.all([
      OrderModel.countDocuments({ userId }),
      OrderModel.countDocuments({ userId, status: { $in: ['pending_review', 'active'] } }),
      SellRequestModel.countDocuments({ userId }),
      BidModel.countDocuments({ bidderId: userId }),
      walletService.get(userId),
    ]);
    const live = await AuctionModel.countDocuments({ 'highest.bidderId': userId, status: 'live' });
    res.json({
      orders: { total: ordersTotal, active: ordersActive },
      sellRequests,
      auctions: { bidsPlaced, leading: live },
      balance: mobileMoney({ amountMinor: wallet.availableMinor, currency: wallet.currency }),
    });
  }));

  r.get('/me/tier', requireUser, ah(async (req, res) => {
    const u = await users.getUserOrThrow(currentUserId(req));
    res.json({ tier: { id: u.tier, ...TIER_LABELS[u.tier] }, chosen: Boolean(u.tierChosenAt), changeRequiresReview: Boolean(u.tierChosenAt) });
  }));

  r.put('/me/tier', requireUser, validate({ body: tierBody }), ah(async (req, res) => {
    const userId = currentUserId(req);
    const tier = (req.body as { tierId: Tier }).tierId;
    const u = await users.getUserOrThrow(userId);
    if (!u.tierChosenAt) {
      const updated = await users.setTier(userId, tier);
      res.json({ tier: { id: updated.tier, ...TIER_LABELS[updated.tier] }, status: 'applied' });
      return;
    }
    if (tier === u.tier) {
      res.json({ tier: { id: u.tier, ...TIER_LABELS[u.tier] }, status: 'applied' });
      return;
    }
    // Tier changes after onboarding are compliance-reviewed (X-1): raise a ticket instead of switching.
    const ticket = await SupportTicketModel.create({
      reference: await references.ticket(),
      userId,
      topic: 'tier_change',
      subject: `Tier change request: ${u.tier} to ${tier}`,
      body: `Customer requested Tier ${tier}.`,
      status: 'open',
      messages: [],
      attachmentIds: [],
      version: 0,
    });
    res.status(202).json({ tier: { id: u.tier, ...TIER_LABELS[u.tier] }, status: 'pending_review', ticketId: ticket._id });
  }));

  r.get('/me/preferences', requireUser, ah(async (req, res) => res.json((await users.getUserOrThrow(currentUserId(req))).preferences)));
  r.patch('/me/preferences', requireUser, validate({ body: preferencesBody }), ah(async (req, res) => res.json((await users.updatePreferences(currentUserId(req), req.body)).preferences)));

  const aid = validate({ params: addressParam });
  r.get('/me/addresses', requireUser, ah(async (req, res) => res.json({ data: (await users.listAddresses(currentUserId(req))).map(address) })));
  r.post('/me/addresses', requireUser, validate({ body: addressBody }), ah(async (req, res) => res.status(201).json(address(await users.addAddress(currentUserId(req), { ...req.body, source: 'manual' })))));
  r.patch('/me/addresses/:addressId', requireUser, aid, validate({ body: addressPatch }), ah(async (req, res) => res.json(address(await users.updateAddress(currentUserId(req), String(req.params.addressId), req.body)))));
  r.delete('/me/addresses/:addressId', requireUser, aid, ah(async (req, res) => { await users.removeAddress(currentUserId(req), String(req.params.addressId)); res.status(204).end(); }));

  return r;
}

/* -- web /account ---------------------------------------------------------------------- */

export function webAccountRouter(): Router {
  const r = Router();

  r.get('/account/profile', requireUser, ah(async (req, res) => res.json(webProfile(await users.getUserOrThrow(currentUserId(req))))));
  r.patch('/account/profile', requireUser, validate({ body: profileBody }), ah(async (req, res) => res.json(webProfile(await users.updateProfile(currentUserId(req), req.body)))));
  r.put('/account/avatar', requireUser, validate({ body: avatarBody }), ah(async (req, res) => res.json(webProfile(await setAvatar(currentUserId(req), req.body.fileId)))));
  // Contract: POST /account/avatar
  r.post('/account/avatar', requireUser, validate({ body: avatarBody }), ah(async (req, res) => res.json(webProfile(await setAvatar(currentUserId(req), req.body.fileId)))));

  const pid = validate({ params: payoutIdParam });
  r.get('/account/payout-methods', requireUser, ah(async (req, res) => res.json({ items: (await payoutsService.listAccounts(currentUserId(req))).map(toWebPayoutMethod) })));
  r.post('/account/payout-methods', requireUser, validate({ body: createAccountBody }), ah(async (req, res) => {
    currentUser(req);
    res.status(201).json(toWebPayoutMethod(await payoutsService.createAccount(currentUserId(req), req.body)));
  }));
  r.patch('/account/payout-methods/:accountId', requireUser, pid, validate({ body: patchAccountBody }), ah(async (req, res) => res.json(toWebPayoutMethod(await payoutsService.patchAccount(currentUserId(req), String(req.params.accountId), req.body)))));
  r.post('/account/payout-methods/:accountId/default', requireUser, pid, ah(async (req, res) => res.json(toWebPayoutMethod(await payoutsService.setDefault(currentUserId(req), String(req.params.accountId))))));
  r.delete('/account/payout-methods/:accountId', requireUser, pid, ah(async (req, res) => { await payoutsService.deleteAccount(currentUserId(req), String(req.params.accountId)); res.status(204).end(); }));

  return r;
}
