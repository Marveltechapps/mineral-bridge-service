import type { UpdateQuery } from 'mongoose';
import { isValidObjectId } from 'mongoose';
import { opaqueId, IdPrefixes } from '../../common/utils/ids.js';
import { UserModel } from './user.model.js';
import type {
  AddressKind,
  CreateUserInput,
  UserAddress,
  UserRecord,
  UserShape,
} from './user.types.js';

type LeanUser = UserShape & { _id: { toString(): string } };

function toRecord(raw: LeanUser | null): UserRecord | null {
  if (!raw) return null;
  const { _id, ...rest } = raw as LeanUser & Record<string, unknown>;
  return { ...(rest as unknown as UserShape), id: _id.toString() };
}

export function isDuplicateKeyError(err: unknown): err is { code: 11000; keyPattern?: Record<string, unknown> } {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export const userRepository = {
  async findById(id: string, opts: { includeDeleted?: boolean } = {}): Promise<UserRecord | null> {
    if (!isValidObjectId(id)) return null;
    const raw = await UserModel.findById(id).lean<LeanUser>();
    if (raw?.isDeleted && !opts.includeDeleted) return null;
    return toRecord(raw);
  },

  async findByPhone(phone: string): Promise<UserRecord | null> {
    return toRecord(await UserModel.findOne({ phone, isDeleted: false }).lean<LeanUser>());
  },

  async findByEmail(email: string): Promise<UserRecord | null> {
    return toRecord(
      await UserModel.findOne({ email: email.toLowerCase(), isDeleted: false }).lean<LeanUser>(),
    );
  },

  /** Secrets are `select: false`; this is the only read path that returns them. */
  async findSecrets(
    id: string,
  ): Promise<{ passwordHash?: string; pinHash?: string; pinFailCount: number; pinLockedUntil?: Date } | null> {
    if (!isValidObjectId(id)) return null;
    const raw = await UserModel.findById(id)
      .select('+passwordHash +pinHash pinFailCount pinLockedUntil isDeleted')
      .lean<{
        passwordHash?: string;
        pinHash?: string;
        pinFailCount: number;
        pinLockedUntil?: Date;
        isDeleted: boolean;
      }>();
    if (!raw || raw.isDeleted) return null;
    return {
      passwordHash: raw.passwordHash,
      pinHash: raw.pinHash,
      pinFailCount: raw.pinFailCount ?? 0,
      pinLockedUntil: raw.pinLockedUntil,
    };
  },

  async create(input: CreateUserInput): Promise<UserRecord> {
    const now = new Date();
    const doc = await UserModel.create({
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.phone && input.phoneVerified ? { phoneVerifiedAt: now } : {}),
      ...(input.email ? { email: input.email.toLowerCase() } : {}),
      ...(input.email && input.emailVerified ? { emailVerifiedAt: now } : {}),
      roles: input.roles ?? ['both'],
      profile: input.profile ?? {},
      ...(input.acceptedTerms ? { acceptedTerms: { version: input.acceptedTerms.version, at: now } } : {}),
      ...(input.tier ? { tier: input.tier } : {}),
      lastLoginAt: now,
    });
    return toRecord(doc.toObject() as unknown as LeanUser)!;
  },

  async update(id: string, update: UpdateQuery<UserShape>): Promise<UserRecord | null> {
    if (!isValidObjectId(id)) return null;
    return toRecord(
      await UserModel.findOneAndUpdate({ _id: id, isDeleted: false }, update, {
        new: true,
        runValidators: true,
      }).lean<LeanUser>(),
    );
  },

  async touchLogin(id: string, now = new Date()): Promise<void> {
    await UserModel.updateOne({ _id: id }, { $set: { lastLoginAt: now } });
  },

  // ---- addresses -----------------------------------------------------------------------------

  async addAddress(
    userId: string,
    address: Omit<UserAddress, 'id' | 'savedAt'>,
  ): Promise<UserAddress | null> {
    const entry: UserAddress = { ...address, id: opaqueId(IdPrefixes.address), savedAt: new Date() };
    const doc = await UserModel.findOne({ _id: userId, isDeleted: false });
    if (!doc) return null;
    const first = !doc.addresses.some((a) => a.kind === entry.kind);
    if (entry.isDefault || first) {
      doc.addresses.forEach((a) => {
        if (a.kind === entry.kind) a.isDefault = false;
      });
      entry.isDefault = true;
    }
    doc.addresses.push(entry);
    await doc.save();
    return entry;
  },

  async updateAddress(
    userId: string,
    addressId: string,
    patch: Partial<Omit<UserAddress, 'id' | 'savedAt'>>,
  ): Promise<UserAddress | null> {
    const doc = await UserModel.findOne({ _id: userId, isDeleted: false });
    if (!doc) return null;
    const target = doc.addresses.find((a) => a.id === addressId);
    if (!target) return null;
    const kind: AddressKind = patch.kind ?? target.kind;
    if (patch.isDefault) {
      doc.addresses.forEach((a) => {
        if (a.kind === kind && a.id !== addressId) a.isDefault = false;
      });
    }
    Object.assign(target, patch);
    await doc.save();
    return { ...(target as unknown as UserAddress) };
  },

  async removeAddress(userId: string, addressId: string): Promise<boolean> {
    const res = await UserModel.updateOne(
      { _id: userId, isDeleted: false },
      { $pull: { addresses: { id: addressId } } },
    );
    return res.modifiedCount > 0;
  },

  // ---- PIN ---------------------------------------------------------------------------------

  async setPin(id: string, pinHash: string): Promise<void> {
    await UserModel.updateOne(
      { _id: id },
      { $set: { pinHash, pinSetAt: new Date(), pinFailCount: 0 }, $unset: { pinLockedUntil: 1 } },
    );
  },

  /** Atomically records a failed attempt; locks when the threshold is reached. Returns the new state. */
  async registerPinFailure(
    id: string,
    opts: { maxFailures: number; lockedUntil: Date },
  ): Promise<{ failCount: number; lockedUntil?: Date }> {
    const after = await UserModel.findOneAndUpdate(
      { _id: id },
      { $inc: { pinFailCount: 1 } },
      { new: true, projection: { pinFailCount: 1 } },
    ).lean<{ pinFailCount: number }>();
    const failCount = after?.pinFailCount ?? 0;
    if (failCount >= opts.maxFailures) {
      await UserModel.updateOne(
        { _id: id },
        { $set: { pinLockedUntil: opts.lockedUntil, pinFailCount: 0 } },
      );
      return { failCount, lockedUntil: opts.lockedUntil };
    }
    return { failCount };
  },

  async resetPinFailures(id: string): Promise<void> {
    await UserModel.updateOne(
      { _id: id },
      { $set: { pinFailCount: 0 }, $unset: { pinLockedUntil: 1 } },
    );
  },

  // ---- password ----------------------------------------------------------------------------

  async setPasswordHash(id: string, passwordHash: string): Promise<void> {
    await UserModel.updateOne(
      { _id: id },
      { $set: { passwordHash, passwordChangedAt: new Date() } },
    );
  },

  // ---- lifecycle ---------------------------------------------------------------------------

  async scheduleDeletion(id: string, at: Date, reason?: string): Promise<UserRecord | null> {
    return toRecord(
      await UserModel.findOneAndUpdate(
        { _id: id, isDeleted: false },
        { $set: { deletionScheduledAt: at, ...(reason ? { deletionReason: reason } : {}) } },
        { new: true },
      ).lean<LeanUser>(),
    );
  },

  /**
   * Soft-delete + anonymise PII (M-20 / X-10). KYC and transaction records keep pointing at the
   * user id for the statutory retention period; the unique phone/email are released.
   */
  async anonymise(id: string, reason?: string): Promise<boolean> {
    const now = new Date();
    const res = await UserModel.updateOne(
      { _id: id, isDeleted: false },
      {
        $set: {
          isDeleted: true,
          deletedAt: now,
          ...(reason ? { deletionReason: reason } : {}),
          profile: { fullName: 'Deleted user' },
          addresses: [],
          preferences: {
            language: 'en',
            currency: 'USD',
            units: 'metric',
            alerts: { bids: false, orders: false, lots: false, marketing: false },
            biometric: false,
          },
        },
        $unset: {
          phone: 1,
          phoneVerifiedAt: 1,
          email: 1,
          emailVerifiedAt: 1,
          passwordHash: 1,
          pinHash: 1,
          pinLockedUntil: 1,
          deletionScheduledAt: 1,
          acceptedTerms: 1,
        },
      },
    );
    return res.modifiedCount > 0;
  },

  async findDueForDeletion(now: Date, limit = 100): Promise<UserRecord[]> {
    const rows = await UserModel.find({ isDeleted: false, deletionScheduledAt: { $lte: now } })
      .limit(limit)
      .lean<LeanUser[]>();
    return rows.map((r) => toRecord(r)!);
  },
};
