import { z } from 'zod';
import { AppError, conflict, notFound, unprocessable } from '../../../common/errors/app-error.js';
import { nextId } from '../../../common/db/sequence.js';
import { withTx } from '../../../common/db/transaction.js';
import { Banner } from '../../../models/content.models.js';
import { recordAudit } from '../../audit/audit.service.js';
import { BANNER_PLACEMENTS, LABELS } from '../shared/enums.js';
import { action, and, boolQ, escapeRegex, isoDate, oneOf, pageOf, paging } from '../shared/http.js';
import { loadFileRefs } from '../shared/files.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { auditActor } from '../shared/staff-context.js';

const KIND_OF: Record<string, string> = { homepage_hero: 'hero', homepage_secondary: 'secondary', in_app_promo: 'promo_card', category_miners: 'category', category_buyers: 'category', email_strip: 'email' };

const bannerDto = (b: Record<string, any>) => ({  
  id: b.bannerId,
  title: b.title,
  placement: b.placement,
  kind: b.kind,
  activeFrom: b.activeFrom ? isoDate(b.activeFrom) : isoDate(b.createdAt),
  activeUntil: b.activeUntil ? isoDate(b.activeUntil) : null,
  linkTarget: b.linkTarget,
  active: !!b.active,
  imageFileId: b.imageFileId ?? null,
});

/** Internal paths only: "/sell/gold" ok; "https://…", "//host", "javascript:", backslashes are not. */
const internalPath = z.string().trim().min(1).max(300).refine((v) => /^\/(?!\/)[^\s\\]*$/.test(v), { message: 'link-target-invalid' });
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

const linkInvalid = () => new AppError({ status: 422, code: 'rule/link-target-invalid', message: 'Link target must be an internal path such as /sell/gold-concentrate.', fields: { linkTarget: 'Must start with a single "/"' } });
const datesInvalid = () => new AppError({ status: 422, code: 'rule/dates', message: 'The end date must be on or after the start date.', fields: { activeUntil: 'Before start date' } });

function checkLink(v: string) {
  if (!internalPath.safeParse(v).success) throw linkInvalid();
}

async function assertSlotFree(candidate: { bannerId?: string; placement: string; activeFrom: Date; activeUntil: Date | null }) {
  if (candidate.placement !== 'homepage_hero') return;
  const far = new Date('9999-12-31T00:00:00.000Z');
  const clash = await Banner.findOne({
    active: true,
    placement: 'homepage_hero',
    ...(candidate.bannerId ? { bannerId: { $ne: candidate.bannerId } } : {}),
    $and: [{ $or: [{ activeFrom: { $exists: false } }, { activeFrom: null }, { activeFrom: { $lte: candidate.activeUntil ?? far } }] }, { $or: [{ activeUntil: null }, { activeUntil: { $exists: false } }, { activeUntil: { $gte: candidate.activeFrom } }] }],
  }).lean();
  if (clash) throw new AppError({ status: 422, code: 'rule/slot-occupied', message: `The homepage hero is already taken by "${clash.title}" for overlapping dates.`, details: { conflictingBannerId: clash.bannerId } });
}

export const marketingRoutes: AdminRouteDef[] = [
  route(113, 'GET /marketing/banners', ['content', 'view'], async (req, res) => {
    const placement = oneOf(req.query.placement, BANNER_PLACEMENTS, 'placement');
    const active = boolQ(req.query.active);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const re = q ? new RegExp(escapeRegex(q), 'i') : null;
    const labelHits = q ? LABELS.bannerPlacements.filter(([, label]) => re!.test(label)).map(([k]) => k) : [];
    res.json(
      await pageOf(Banner, {
        filter: and(placement && { placement }, active !== undefined && { active }, re && { $or: [{ title: re }, { linkTarget: re }, { bannerId: re }, { placement: { $in: labelHits } }] }, { status: { $ne: 'draft' } }),
        sort: { active: -1, createdAt: -1, _id: 1 },
        paging: paging(req),
        map: (docs: any[]) => docs.map(bannerDto),  
      }),
    );
  }),

  route(114, 'POST /marketing/banners', ['content', 'edit'], async (req, res) => {
    const b = req.body as { title: string; placement: (typeof BANNER_PLACEMENTS)[number]; activeFrom: string; activeUntil?: string | null; linkTarget: string; imageFileId?: string; draft: boolean };
    checkLink(b.linkTarget);
    const from = toDate(b.activeFrom);
    const until = b.activeUntil ? toDate(b.activeUntil) : null;
    if (until && until < from) throw datesInvalid();
    if (b.imageFileId && !(await loadFileRefs([b.imageFileId])).has(b.imageFileId)) throw unprocessable('Unknown image file', { imageFileId: 'Unknown file' });
    const actor = auditActor(req);
    const banner = await withTx(async (session) => {
      const bannerId = await nextId('banner', session);
      const [created] = await Banner.create([{ bannerId, title: b.title, placement: b.placement, kind: KIND_OF[b.placement], activeFrom: from, activeUntil: until, linkTarget: b.linkTarget, active: false, status: b.draft ? 'draft' : 'saved', imageFileId: b.imageFileId, createdBy: actor.staffId }], { session });
      await recordAudit({ actor, category: 'content', action: 'Created banner', record: { type: 'banner', id: bannerId, label: b.title }, after: { placement: b.placement, activeFrom: b.activeFrom, activeUntil: b.activeUntil ?? null, linkTarget: b.linkTarget }, req, session });
      return created!.toObject();
    });
    res.status(201).json({ ...bannerDto(banner), message: 'Banner created — inactive until you toggle it live' });
  }, {
    body: z.object({ title: z.string().trim().min(2).max(160), placement: z.enum(BANNER_PLACEMENTS), activeFrom: dateOnly, activeUntil: dateOnly.nullable().optional(), linkTarget: z.string().min(1).max(300), imageFileId: z.string().optional(), draft: z.boolean().default(false) }),
  }),

  route(115, 'PATCH /marketing/banners/:bannerId', ['content', 'edit'], async (req, res) => {
    const bannerId = String(req.params.bannerId);
    const b = req.body as { title?: string; placement?: (typeof BANNER_PLACEMENTS)[number]; activeFrom?: string; activeUntil?: string | null; linkTarget?: string; active?: boolean; imageFileId?: string | null };
    const before = await Banner.findOne({ bannerId }).lean();
    if (!before) throw notFound('resource/not-found', `Banner ${bannerId} not found`);
    if (b.linkTarget !== undefined) checkLink(b.linkTarget);
    if (b.imageFileId && !(await loadFileRefs([b.imageFileId])).has(b.imageFileId)) throw unprocessable('Unknown image file', { imageFileId: 'Unknown file' });

    const from = b.activeFrom ? toDate(b.activeFrom) : (before.activeFrom as Date | undefined) ?? before.createdAt;
    const until = b.activeUntil === undefined ? ((before.activeUntil as Date | null | undefined) ?? null) : b.activeUntil ? toDate(b.activeUntil) : null;
    if (until && until < from) throw datesInvalid();
    const placement = b.placement ?? before.placement;
    const active = b.active ?? !!before.active;
    if (active) await assertSlotFree({ bannerId, placement, activeFrom: from, activeUntil: until });

    const set: Record<string, unknown> = {};
    if (b.title !== undefined) set.title = b.title;
    if (b.placement !== undefined) { set.placement = b.placement; set.kind = KIND_OF[b.placement]; }
    if (b.activeFrom !== undefined) set.activeFrom = from;
    if (b.activeUntil !== undefined) set.activeUntil = until;
    if (b.linkTarget !== undefined) set.linkTarget = b.linkTarget;
    if (b.active !== undefined) { set.active = b.active; set.status = 'saved'; }
    if (b.imageFileId !== undefined) set.imageFileId = b.imageFileId;

    const actor = auditActor(req);
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Banner.findOneAndUpdate({ bannerId, __v: before.__v }, { $set: set, $inc: { __v: 1 } }, { new: true, session }).lean();
      if (!updated) throw conflict('conflict/stale-state', `${bannerId} was changed by someone else — reload and retry.`);
      const toggled = b.active !== undefined && b.active !== !!before.active;
      const auditId = await recordAudit({ actor, category: 'content', action: toggled ? (b.active ? 'Set banner live' : 'Took banner offline') : 'Updated banner', record: { type: 'banner', id: bannerId, label: updated.title }, before: Object.fromEntries(Object.keys(set).map((k) => [k, (before as Record<string, unknown>)[k]])), after: set, req, session });
      return { updated, auditId };
    });
    const toggled = b.active !== undefined && b.active !== !!before.active;
    const message = toggled ? (b.active ? `'${updated.title}' set live` : `'${updated.title}' taken offline`) : `'${updated.title}' updated`;
    res.json(action(bannerDto(updated), message, auditId));
  }, {
    body: z.object({ title: z.string().trim().min(2).max(160), placement: z.enum(BANNER_PLACEMENTS), activeFrom: dateOnly, activeUntil: dateOnly.nullable(), linkTarget: z.string().min(1).max(300), active: z.boolean(), imageFileId: z.string().nullable() }).partial().refine((o) => Object.keys(o).length > 0, 'Nothing to update'),
  }),
];
