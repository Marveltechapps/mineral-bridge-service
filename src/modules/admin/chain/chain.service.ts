import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { nextId } from '../../../common/db/sequence.js';
import { ChainEvent, Passport } from '../../../models/finance.models.js';

export const sha256 = (v: unknown): string => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

/** Content hash of a ledger event. Pending until a Bitcoin anchor batch includes it. */
export async function recordChainEvent(input: {
  type: 'passport_mint' | 'custody_transfer' | 'lc_event' | 'btc_settlement' | 'bitcoin_anchor';
  ref: { type: string; id: string; label?: string };
  description: string;
  payload?: unknown;
  status?: 'confirmed' | 'pending';
  anchorId?: string;
  session?: ClientSession;
}): Promise<string> {
  const eventId = await nextId('chainEvent', input.session);
  const at = new Date();
  await ChainEvent.create(
    [
      {
        eventId,
        type: input.type,
        ref: input.ref,
        description: input.description,
        txHash: `0x${sha256({ eventId, type: input.type, ref: input.ref, at: at.toISOString(), payload: input.payload ?? null })}`,
        at,
        status: input.status ?? 'pending',
        anchorId: input.anchorId,
      },
    ],
    { session: input.session },
  );
  return eventId;
}

/** Mints a digital passport for a vault lot (called when a sell order reaches custody transfer). */
export async function mintPassport(input: {
  lotId: string;
  orderId: string;
  mineral: string;
  grade?: string;
  quantity: { value: number; unit: string };
  session?: ClientSession;
}) {
  const passportId = await nextId('passport', input.session);
  const mintedAt = new Date();
  const hash = `0x${sha256({ passportId, lotId: input.lotId, orderId: input.orderId, mineral: input.mineral, grade: input.grade ?? null, quantity: input.quantity, mintedAt: mintedAt.toISOString() })}`;
  await Passport.create([{ passportId, lotId: input.lotId, orderId: input.orderId, hash, mintedAt, custodyEvents: 1 }], { session: input.session });
  await recordChainEvent({
    type: 'passport_mint',
    ref: { type: 'passport', id: passportId, label: passportId },
    description: `Passport ${passportId} minted for ${input.lotId}`,
    payload: { hash },
    session: input.session,
  });
  return { passportId, hash };
}
