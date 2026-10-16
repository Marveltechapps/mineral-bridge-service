import type { FilterQuery, UpdateQuery } from 'mongoose';
import { AuctionModel, AuctionWatchModel, AutoBidModel, BidModel } from '../../models/auction.model.js';
import type { IAuction, IAutoBid, IAuctionWatch, IBid } from '../../models/auction.model.js';

export const auctionsRepository = {
  isDuplicateKey: (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000,

  findById: (id: string) => AuctionModel.findById(id).lean<IAuction>(),
  insert: async (doc: Partial<IAuction>) => (await AuctionModel.create(doc)).toObject() as IAuction,

  async list(filter: FilterQuery<IAuction>, sort: Record<string, 1 | -1>, skip: number, limit: number) {
    const [rows, total] = await Promise.all([
      AuctionModel.find(filter).sort(sort).skip(skip).limit(limit).lean<IAuction[]>(),
      AuctionModel.countDocuments(filter),
    ]);
    return { rows, total };
  },
  count: (filter: FilterQuery<IAuction>) => AuctionModel.countDocuments(filter),
  findMany: (ids: string[]) => AuctionModel.find({ _id: { $in: ids } }).lean<IAuction[]>(),

  /** Single-document compare-and-set: the heart of concurrent bidding. */
  cas(filter: FilterQuery<IAuction>, update: UpdateQuery<IAuction>) {
    return AuctionModel.findOneAndUpdate(filter, update, { new: true }).lean<IAuction>();
  },

  insertBid: async (doc: Omit<IBid, 'createdAt'> & { _id: string }) => (await BidModel.create(doc)).toObject() as IBid,
  findBid: (id: string) => BidModel.findById(id).lean<IBid>(),
  findBidByKey: (auctionId: string, bidderId: string, key: string) =>
    BidModel.findOne({ auctionId, bidderId, idempotencyKey: key }).lean<IBid>(),

  async listBids(auctionId: string, skip: number, limit: number) {
    const [rows, total] = await Promise.all([
      BidModel.find({ auctionId }).sort({ seq: -1 }).skip(skip).limit(limit).lean<IBid[]>(),
      BidModel.countDocuments({ auctionId }),
    ]);
    return { rows, total };
  },
  deleteBid: async (id: string): Promise<void> => { await BidModel.deleteOne({ _id: id }); },

  /** Best bid per auction for one user. */
  async viewerBest(userId: string, auctionIds: string[]): Promise<Map<string, number>> {
    if (auctionIds.length === 0) return new Map();
    const rows = await BidModel.aggregate<{ _id: string; best: number }>([
      { $match: { bidderId: userId, auctionId: { $in: auctionIds } } },
      { $group: { _id: '$auctionId', best: { $max: '$amountMinor' } } },
    ]);
    return new Map(rows.map((r) => [r._id, r.best]));
  },

  async auctionsBidOn(userId: string): Promise<{ auctionId: string; best: number; lastAt: Date }[]> {
    const rows = await BidModel.aggregate<{ _id: string; best: number; lastAt: Date }>([
      { $match: { bidderId: userId } },
      { $group: { _id: '$auctionId', best: { $max: '$amountMinor' }, lastAt: { $max: '$placedAt' } } },
      { $sort: { lastAt: -1 } },
      { $limit: 500 },
    ]);
    return rows.map((r) => ({ auctionId: r._id, best: r.best, lastAt: r.lastAt }));
  },

  /* auto-bid */
  upsertAutoBid: (auctionId: string, userId: string, ceilingMinor: number, currency: string) =>
    AutoBidModel.findOneAndUpdate(
      { auctionId, userId },
      { $set: { ceilingMinor, currency, active: true } },
      { upsert: true, new: true },
    ).lean<IAutoBid>(),
  deactivateAutoBid: (auctionId: string, userId: string) =>
    AutoBidModel.updateOne({ auctionId, userId }, { $set: { active: false } }),
  findAutoBid: (auctionId: string, userId: string) => AutoBidModel.findOne({ auctionId, userId, active: true }).lean<IAutoBid>(),
  autoBidCandidates: (auctionId: string, excludeUserId: string | undefined, minCeiling: number) =>
    AutoBidModel.find({
      auctionId,
      active: true,
      ceilingMinor: { $gte: minCeiling },
      ...(excludeUserId ? { userId: { $ne: excludeUserId } } : {}),
    })
      .sort({ ceilingMinor: -1, _id: 1 })
      .limit(5)
      .lean<IAutoBid[]>(),
  viewerAutoBids: (userId: string, auctionIds: string[]) =>
    AutoBidModel.find({ userId, auctionId: { $in: auctionIds }, active: true }).lean<IAutoBid[]>(),

  /* watch / reminder */
  upsertWatch: (auctionId: string, userId: string, kind: 'watch' | 'reminder', set: Partial<IAuctionWatch>) =>
    AuctionWatchModel.findOneAndUpdate({ auctionId, userId, kind }, { $set: set }, { upsert: true, new: true }).lean<IAuctionWatch>(),
  deleteWatch: (auctionId: string, userId: string, kind: 'watch' | 'reminder') =>
    AuctionWatchModel.deleteOne({ auctionId, userId, kind }),
  viewerReminders: (userId: string, auctionIds: string[]) =>
    AuctionWatchModel.find({ userId, kind: 'reminder', auctionId: { $in: auctionIds } }).lean<IAuctionWatch[]>(),
};
