import { z } from 'zod';
import { AppError, notFound } from '../../../common/errors/app-error.js';
import { loadEnv } from '../../../config/env.js';
import { nextId } from '../../../common/db/sequence.js';
import { withTx } from '../../../common/db/transaction.js';
import { Anchor, ChainEvent, Passport } from '../../../models/finance.models.js';
import { recordAudit } from '../../audit/audit.service.js';
import { auditActor } from '../shared/staff-context.js';
import { CHAIN_EVENT_TYPES, MS_DAY } from '../shared/enums.js';
import { and, dateQ, iso, isoDate, oneOf, pageOf, paging, searchFilter } from '../shared/http.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { timeAgo } from '../shared/notify.js';
import { sha256 } from './chain.service.js';

export const BATCH_WINDOW_MS = 10 * 60_000;

/** Binary sha256 merkle root over sorted leaf hashes (odd node is promoted). */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256('empty');
  let level = [...leaves].sort().map((l) => sha256(l));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? sha256(level[i]! + level[i + 1]!) : level[i]!);
    level = next;
  }
  return level[0]!;
}

function providerOrThrow(): string {
  const provider = loadEnv().BLOCKCHAIN_PROVIDER;
  if (!provider) {
    throw new AppError({ status: 503, code: 'chain/provider-unconfigured', message: 'No blockchain anchoring provider is configured (BLOCKCHAIN_PROVIDER).', details: { env: 'BLOCKCHAIN_PROVIDER' } });
  }
  return provider;
}

/**
 * Called by the anchoring provider/worker once the batch transaction is mined: records the block and links
 * every un-anchored passport and chain event to the anchor.
 */
export async function confirmAnchor(anchorId: string, input: { block: number; txId: string; confirmations: number; explorerUrl?: string }) {
  return withTx(async (session) => {
    const anchor = await Anchor.findOneAndUpdate({ anchorId, status: { $in: ['queued', 'broadcast'] } }, { $set: { status: 'confirmed', at: new Date(), ...input } }, { new: true, session }).lean();
    if (!anchor) return null;
    await Passport.updateMany({ anchorId: { $exists: false } }, { $set: { anchorId } }, { session });
    await ChainEvent.updateMany({ anchorId: { $exists: false } }, { $set: { anchorId, status: 'confirmed' } }, { session });
    return anchor;
  });
}

function anchorDto(a: Record<string, any>, nextBatchClosesAt: Date | null) {  
  return {
    id: a.anchorId,
    block: a.block ?? null,
    confirmations: a.confirmations ?? 0,
    at: iso(a.at),
    merkleRoot: a.merkleRoot,
    txId: a.txId ?? null,
    explorerUrl: a.explorerUrl ?? null,
    batch: { passports: a.batch?.passports ?? 0, custodyEvents: a.batch?.custodyEvents ?? 0 },
    nextBatchClosesAt: iso(nextBatchClosesAt),
  };
}

export const chainRoutes: AdminRouteDef[] = [
  route(82, 'GET /chain/network-status', ['financial', 'view'], async (_req, res) => {
    const provider = loadEnv().BLOCKCHAIN_PROVIDER;
    const [passports, lastMint, latest, pending] = await Promise.all([
      Passport.countDocuments(),
      Passport.findOne().sort({ mintedAt: -1 }).lean(),
      Anchor.findOne({ status: { $in: ['confirmed', 'broadcast'] } }).sort({ at: -1 }).lean(),
      ChainEvent.countDocuments({ status: 'pending' }),
    ]);
    res.json({
      data: [
        { key: 'passport_ledger', name: 'Passport ledger', state: 'healthy', ok: true, meta: `${passports} passports${lastMint ? ` · last minted ${timeAgo(lastMint.mintedAt)}` : ''}` },
        provider
          ? { key: 'anchor_service', name: 'Anchor service', state: latest ? 'healthy' : 'idle', ok: true, meta: latest ? `Last anchor ${timeAgo(latest.at)} · ${pending} events pending` : `Provider ${provider} · no anchor yet` }
          : { key: 'anchor_service', name: 'Anchor service', state: 'unconfigured', ok: false, meta: 'BLOCKCHAIN_PROVIDER is not set — anchoring is disabled' },
        provider
          ? { key: 'nodes', name: 'Bitcoin nodes', state: latest ? 'healthy' : 'unknown', ok: Boolean(latest), meta: latest ? `Block ${latest.block?.toLocaleString('en-US') ?? '—'}` : 'Waiting for first confirmation' }
          : { key: 'nodes', name: 'Bitcoin nodes', state: 'unconfigured', ok: false, meta: 'No provider configured' },
      ],
    });
  }),

  route(83, 'GET /chain/anchors/latest', ['financial', 'view'], async (_req, res) => {
    const [latest, queued] = await Promise.all([Anchor.findOne({ status: { $in: ['confirmed', 'broadcast'] } }).sort({ at: -1 }).lean(), Anchor.findOne({ status: 'queued' }).sort({ closesAt: 1 }).lean()]);
    if (!latest) throw notFound('chain/no-anchor', 'No anchor has been recorded yet');
    res.json(anchorDto(latest, queued?.closesAt ?? null));
  }),

  route(84, 'GET /chain/passports/stats', ['financial', 'view'], async (req, res) => {
    const weeks = Math.min(52, Math.max(1, Number(req.query.weeks ?? 8) || 8));
    const monday = (d: Date) => {
      const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
      return x;
    };
    const thisWeek = monday(new Date());
    const start = new Date(thisWeek.getTime() - (weeks - 1) * 7 * MS_DAY);
    const [total, rows] = await Promise.all([Passport.countDocuments(), Passport.find({ mintedAt: { $gte: start } }).select('mintedAt').lean()]);
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(isoDate(monday(r.mintedAt)), (counts.get(isoDate(monday(r.mintedAt))) ?? 0) + 1);
    const weekly = Array.from({ length: weeks }, (_, i) => {
      const weekStart = isoDate(new Date(start.getTime() + i * 7 * MS_DAY));
      return { weekStart, count: counts.get(weekStart) ?? 0 };
    });
    res.json({ total, thisWeek: weekly[weekly.length - 1]!.count, weekly });
  }),

  route(85, 'GET /chain/events', ['financial', 'view'], async (req, res) => {
    const type = oneOf(req.query.type, CHAIN_EVENT_TYPES, 'type');
    const since = dateQ(req.query.since, 'since');
    const filter = and(type && { type }, since && { at: { $gt: since } }, searchFilter(req.query.q, ['type', 'ref.id', 'ref.label', 'description', 'txHash']));
    res.json(
      await pageOf(ChainEvent, {
        filter,
        sort: { at: -1, _id: -1 },
        paging: paging(req),
        map: (docs: any[]) =>  
          docs.map((e) => ({ id: e.eventId, type: e.type, ref: { type: e.ref?.type, id: e.ref?.id, label: e.ref?.label ?? e.ref?.id }, description: e.description ?? '', txHash: e.txHash, at: iso(e.at), status: e.status })),
      }),
    );
  }),

  route(86, 'POST /chain/passports/verify', ['financial', 'view'], async (req, res) => {
    const b = req.body as { passportId?: string; hash?: string };
    const hash = b.hash ? (b.hash.startsWith('0x') ? b.hash : `0x${b.hash}`).toLowerCase() : undefined;
    const p = b.passportId ? await Passport.findOne({ passportId: b.passportId }).lean() : await Passport.findOne({ hash }).lean();
    if (!p) return void res.json({ valid: false, reason: 'not_found', message: `${b.passportId ?? hash} was not found on the ledger` });
    if (b.passportId && hash && p.hash.toLowerCase() !== hash) {
      return void res.json({ valid: false, reason: 'hash_mismatch', passportId: p.passportId, message: `Hash does not match ${p.passportId}` });
    }
    const anchor = p.anchorId ? await Anchor.findOne({ anchorId: p.anchorId, status: 'confirmed' }).lean() : null;
    if (!anchor) return void res.json({ valid: false, reason: 'not_yet_anchored', passportId: p.passportId, lotId: p.lotId, custodyEvents: p.custodyEvents ?? 1, message: `${p.passportId} is minted but not yet anchored — it joins the next batch` });
    res.json({ valid: true, passportId: p.passportId, lotId: p.lotId, anchor: { id: anchor.anchorId, block: anchor.block, txId: anchor.txId }, custodyEvents: p.custodyEvents ?? 1, message: `${p.passportId} verified — anchored in block ${anchor.block?.toLocaleString('en-US')}` });
  }, { body: z.object({ passportId: z.string().trim().min(1).optional(), hash: z.string().trim().regex(/^(0x)?[0-9a-fA-F]{16,128}$/, 'Enter a valid hash').optional() }).refine((v) => Boolean(v.passportId) !== Boolean(v.hash), { message: 'Provide either passportId or hash' }) }),

  route(87, 'POST /chain/anchors', ['financial', 'edit'], async (req, res) => {
    providerOrThrow();
    const { reason } = req.body as { reason?: string };
    const actor = auditActor(req);
    const now = new Date();
    const { anchor, auditId } = await withTx(async (session) => {
      let anchor = await Anchor.findOne({ status: 'queued' }, null, { session }).lean();
      if (anchor) {
        anchor = await Anchor.findOneAndUpdate({ anchorId: anchor.anchorId }, { $set: { manual: true, reason, requestedBy: actor.staffId } }, { new: true, session }).lean();
      } else {
        const [passports, events] = await Promise.all([
          Passport.find({ anchorId: { $exists: false } }, null, { session }).select('hash').lean(),
          ChainEvent.find({ anchorId: { $exists: false } }, null, { session }).select('txHash').lean(),
        ]);
        const anchorId = await nextId('anchor', session);
        const [created] = await Anchor.create(
          [{ anchorId, status: 'queued', merkleRoot: `0x${merkleRoot([...passports.map((p) => p.hash), ...events.map((e) => e.txHash)])}`, batch: { passports: passports.length, custodyEvents: events.length }, closesAt: new Date(now.getTime() + BATCH_WINDOW_MS), manual: true, reason, requestedBy: actor.staffId }],
          { session },
        );
        anchor = created.toObject();
      }
      const auditId = await recordAudit({ actor, category: 'financial', action: 'Queued manual chain anchor', record: { type: 'anchor', id: anchor!.anchorId, label: anchor!.anchorId }, after: { closesAt: anchor!.closesAt }, reason, req, session, activity: { text: `Manual anchor ${anchor!.anchorId} queued`, kind: 'chain' } });
      return { anchor: anchor!, auditId };
    });
    const mins = Math.max(1, Math.ceil((anchor.closesAt.getTime() - Date.now()) / 60_000));
    res.status(202).json({ queuedFor: anchor.anchorId, closesAt: anchor.closesAt.toISOString(), auditId, message: `Manual anchor queued — next batch closes in ${mins} min` });
  }, { body: z.object({ reason: z.string().trim().max(500).optional() }).default({}) }),
];
