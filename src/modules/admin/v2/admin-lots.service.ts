/**
 * Lot media, documents and stock for the admin console.
 *
 * Images and documents are stored through the same uploads service the rest of the API uses. An
 * image is public (it is shown to buyers), a document is private and is served by signed URL.
 * Stock changes are compare-and-set on the stored grams and each one writes an audit row with the
 * reason, which the console reads back as the lot's movement history.
 */
import { readFile } from 'node:fs/promises';
import { conflict, notFound, unprocessable } from '../../../common/errors/app-error.js';
import { loadEnv } from '../../../config/env.js';
import { opaqueId } from '../../../common/utils/ids.js';
import { GRAMS_PER_UNIT } from '../../../common/utils/quantity.js';
import { FileModel } from '../../../models/file.model.js';
import { ProductModel, type IProduct } from '../../../models/catalog.model.js';
import { AuditLog } from '../../audit/audit.model.js';
import { recordAudit } from '../../audit/audit.service.js';
import { canonicalDocumentType } from '../../catalog/product-documents.js';
import { absoluteStoragePath } from '../../storage/storage.service.js';
import { uploadsService } from '../../uploads/uploads.service.js';

export type LotStaff = { id: string; name: string; publicId?: string };

const MAX_IMAGES = 20;
const MAX_DOCUMENTS = 30;

const DOC_LABEL: Record<string, string> = {
  lot_test_report: 'Test report',
  certificate_of_analysis: 'Certificate of analysis',
  origin_declaration: 'Origin declaration',
};

type StoredDoc = NonNullable<IProduct['documents']>[number];
type StoredMedia = NonNullable<IProduct['media']>[number];

async function loadLot(ref: string) {
  const lot = await ProductModel.findOne({ reference: ref });
  if (!lot) throw notFound('lot/not-found', 'Lot not found');
  return lot;
}

async function audit(staff: LotStaff, action: string, lot: { reference: string; name: string }, extra?: { before?: unknown; after?: unknown; reason?: string }) {
  await recordAudit({
    actor: { staffId: staff.publicId || staff.id, name: staff.name },
    category: 'catalogue',
    action,
    record: { type: 'Lot', id: lot.reference, label: lot.name },
    ...extra,
  });
}

export function lotImageUrl(fileId: string): string {
  return `${loadEnv().PUBLIC_API_BASE_URL}/storage/lot-media/${encodeURIComponent(fileId)}`;
}

function fileKb(bytes?: number): string {
  const n = bytes ?? 0;
  return n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function docLabel(d: Pick<StoredDoc, 'kind' | 'label'>): string {
  if (d.label) return d.label;
  const canonical = canonicalDocumentType(d.kind);
  return (canonical && DOC_LABEL[canonical]) || d.kind || 'Other';
}

export function mediaView(p: Pick<IProduct, 'media'>) {
  return [...(p.media ?? [])]
    .filter((m) => m.kind !== 'document')
    .sort((a, b) => a.sort - b.sort)
    .map((m) => ({
      id: m._id,
      name: m.name || m.url.split('/').pop() || m._id,
      url: m.url,
      caption: m.caption || '',
      at: m.addedAt ? new Date(m.addedAt).getTime() : 0,
      fileId: m.fileId || '',
      bytes: m.bytes ?? 0,
    }));
}

export function documentsView(p: Pick<IProduct, 'documents'>) {
  return (p.documents ?? []).map((d) => ({
    id: d._id,
    name: d.name,
    type: docLabel(d),
    kind: d.kind,
    ver: d.version ?? 1,
    at: d.addedAt ? new Date(d.addedAt).getTime() : 0,
    by: d.addedBy || '',
    size: fileKb(d.bytes),
    bytes: d.bytes ?? 0,
    visible: d.visible !== false,
    fileId: d.fileId || '',
    history: (d.history ?? []).map((h) => ({ ver: h.version, name: h.name, at: h.at ? new Date(h.at).getTime() : 0, by: h.by || '', size: fileKb(h.bytes) })),
  }));
}

export async function listLotMedia(ref: string) {
  const lot = await ProductModel.findOne({ reference: ref }).lean<IProduct>();
  if (!lot) throw notFound('lot/not-found', 'Lot not found');
  return { reference: lot.reference, images: mediaView(lot), documents: documentsView(lot) };
}

async function storeUpload(
  lot: { _id: string },
  staff: LotStaff,
  input: { filename: string; contentType: string; contentBase64: string },
  isImage: boolean,
) {
  const contentType = input.contentType.split(';')[0]!.trim().toLowerCase();
  if (isImage && !contentType.startsWith('image/')) throw unprocessable('Images must be JPEG, PNG or WebP files.', { contentType: 'Not an image' }, 'upload/unsupported-type');
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (!bytes.length) throw unprocessable('The file is empty.', { contentBase64: 'Required' });
  const target = await uploadsService.createTarget(staff.id, {
    purpose: isImage ? 'listing-photo' : 'document',
    filename: input.filename,
    contentType,
    bytes: bytes.length,
    refType: 'product',
    refId: String(lot._id),
  });
  const stored = await uploadsService.receive(target.file._id, bytes, contentType);
  await FileModel.updateOne(
    { _id: stored._id },
    {
      $set: {
        scan: { status: 'clean', at: new Date() },
        visibility: isImage ? 'public' : 'private',
        uploadedBy: { kind: 'staff', id: staff.id, name: staff.name },
      },
    },
  );
  return { fileId: stored._id, bytes: bytes.length, contentType, filename: stored.filename };
}

/** Keeps the lot's cover (`imageUrl`) pointing at the first uploaded image. Sheet imagery is left alone when no upload exists. */
function syncCover(lot: InstanceType<typeof ProductModel>) {
  const images = [...lot.media].filter((m) => m.kind !== 'document').sort((a, b) => a.sort - b.sort);
  const first = images[0];
  if (first) {
    lot.imageUrl = first.url;
    lot.imageName = first.name;
    lot.imageFileIds = images.map((m) => m.fileId).filter((id): id is string => Boolean(id));
  } else if (lot.imageUrl && lot.imageUrl.includes('/storage/lot-media/')) {
    lot.imageUrl = undefined;
    lot.imageName = undefined;
    lot.imageFileIds = [];
  }
}

function renumber(lot: InstanceType<typeof ProductModel>) {
  const images = [...lot.media].filter((m) => m.kind !== 'document').sort((a, b) => a.sort - b.sort);
  images.forEach((m, i) => {
    m.sort = i;
  });
}

export async function addLotMedia(
  ref: string,
  input: {
    kind?: 'image' | 'document';
    filename: string;
    contentType: string;
    contentBase64: string;
    caption?: string;
    name?: string;
    type?: string;
  },
  staff: LotStaff,
) {
  const lot = await loadLot(ref);
  const isImage = (input.kind ?? 'image') === 'image';
  if (isImage && lot.media.filter((m) => m.kind !== 'document').length >= MAX_IMAGES) {
    throw conflict('lot/media-limit', `A lot can have at most ${MAX_IMAGES} images.`);
  }
  if (!isImage && lot.documents.length >= MAX_DOCUMENTS) {
    throw conflict('lot/document-limit', `A lot can have at most ${MAX_DOCUMENTS} documents.`);
  }
  const file = await storeUpload(lot, staff, input, isImage);
  if (isImage) {
    const id = opaqueId('med');
    lot.media.push({
      _id: id,
      kind: 'image',
      url: lotImageUrl(file.fileId),
      sort: lot.media.filter((m) => m.kind !== 'document').length,
      fileId: file.fileId,
      caption: input.caption?.trim() || undefined,
      name: input.name?.trim() || file.filename,
      bytes: file.bytes,
      addedAt: new Date(),
      addedBy: staff.name,
    } as StoredMedia);
    syncCover(lot);
    lot.version = (lot.version ?? 0) + 1;
    await lot.save();
    await audit(staff, 'Image uploaded', lot, { after: { name: file.filename, id } });
    return { reference: ref, kind: 'image' as const, image: mediaView(lot).find((m) => m.id === id)!, images: mediaView(lot) };
  }
  const id = opaqueId('doc');
  const requested = input.type?.trim();
  const canonical = canonicalDocumentType(requested);
  lot.documents.push({
    _id: id,
    name: input.name?.trim() || file.filename,
    kind: canonical ?? (requested ? requested.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'other' : 'other'),
    label: canonical ? undefined : requested || undefined,
    fileId: file.fileId,
    bytes: file.bytes,
    contentType: file.contentType,
    visible: true,
    version: 1,
    addedAt: new Date(),
    addedBy: staff.name,
  } as StoredDoc);
  lot.version = (lot.version ?? 0) + 1;
  await lot.save();
  await audit(staff, 'Document uploaded', lot, { after: { name: file.filename, id } });
  return { reference: ref, kind: 'document' as const, document: documentsView(lot).find((d) => d.id === id)!, documents: documentsView(lot) };
}

export async function updateLotMedia(
  ref: string,
  mediaId: string,
  patch: {
    caption?: string;
    cover?: boolean;
    move?: 'up' | 'down';
    name?: string;
    type?: string;
    visible?: boolean;
    /** Replace a document's file with a new version. */
    replace?: { filename: string; contentType: string; contentBase64: string };
  },
  staff: LotStaff,
) {
  const lot = await loadLot(ref);
  const image = lot.media.find((m) => m._id === mediaId);
  if (image && image.kind !== 'document') {
    if (patch.caption !== undefined) image.caption = patch.caption.trim();
    if (patch.name !== undefined && patch.name.trim()) image.name = patch.name.trim();
    if (patch.replace) {
      const file = await storeUpload(lot, staff, patch.replace, true);
      if (image.fileId) await FileModel.updateOne({ _id: image.fileId }, { $set: { deletedAt: new Date() } });
      image.fileId = file.fileId;
      image.url = lotImageUrl(file.fileId);
      image.bytes = file.bytes;
      image.name = file.filename;
      image.addedAt = new Date();
    }
    const ordered = [...lot.media].filter((m) => m.kind !== 'document').sort((a, b) => a.sort - b.sort);
    const index = ordered.findIndex((m) => m._id === mediaId);
    if (patch.cover && index > 0) {
      ordered.splice(index, 1);
      ordered.unshift(image);
      ordered.forEach((m, i) => { m.sort = i; });
    } else if (patch.move) {
      const to = patch.move === 'up' ? index - 1 : index + 1;
      if (to >= 0 && to < ordered.length) {
        const other = ordered[to]!;
        const mine = image.sort;
        image.sort = other.sort;
        other.sort = mine;
      }
    }
    renumber(lot);
    syncCover(lot);
    lot.markModified('media');
    lot.version = (lot.version ?? 0) + 1;
    await lot.save();
    await audit(staff, patch.cover ? 'Cover image changed' : patch.move ? 'Images reordered' : patch.replace ? 'Image replaced' : 'Image caption changed', lot, { after: { id: mediaId } });
    return { reference: ref, kind: 'image' as const, image: mediaView(lot).find((m) => m.id === mediaId)!, images: mediaView(lot) };
  }
  const doc = lot.documents.find((d) => d._id === mediaId);
  if (!doc) throw notFound('lot/media-not-found', 'That image or document is not on this lot.');
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw unprocessable('File name cannot be empty.', { name: 'Required' });
    doc.name = patch.name.trim();
  }
  if (patch.type !== undefined) {
    const requested = patch.type.trim();
    const canonical = canonicalDocumentType(requested);
    doc.kind = canonical ?? (requested.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'other');
    doc.label = canonical ? undefined : requested || undefined;
  }
  if (patch.visible !== undefined) doc.visible = patch.visible;
  if (patch.replace) {
    const file = await storeUpload(lot, staff, patch.replace, false);
    doc.history = [
      { version: doc.version ?? 1, name: doc.name, fileId: doc.fileId, bytes: doc.bytes, at: doc.addedAt, by: doc.addedBy },
      ...(doc.history ?? []),
    ];
    doc.version = (doc.version ?? 1) + 1;
    doc.fileId = file.fileId;
    doc.bytes = file.bytes;
    doc.contentType = file.contentType;
    doc.name = patch.name?.trim() || file.filename;
    doc.addedAt = new Date();
    doc.addedBy = staff.name;
  }
  lot.markModified('documents');
  lot.version = (lot.version ?? 0) + 1;
  await lot.save();
  await audit(
    staff,
    patch.replace ? 'Document re-uploaded' : patch.visible !== undefined ? (patch.visible ? 'Document shown to buyers' : 'Document hidden from buyers') : 'Document details edited',
    lot,
    { after: { id: mediaId, name: doc.name } },
  );
  return { reference: ref, kind: 'document' as const, document: documentsView(lot).find((d) => d.id === mediaId)!, documents: documentsView(lot) };
}

export async function removeLotMedia(ref: string, mediaId: string, staff: LotStaff) {
  const lot = await loadLot(ref);
  const image = lot.media.find((m) => m._id === mediaId);
  if (image && image.kind !== 'document') {
    lot.media = lot.media.filter((m) => m._id !== mediaId) as typeof lot.media;
    renumber(lot);
    syncCover(lot);
    lot.version = (lot.version ?? 0) + 1;
    await lot.save();
    // The file row is kept for the record; it is no longer public or referenced.
    if (image.fileId) await FileModel.updateOne({ _id: image.fileId }, { $set: { deletedAt: new Date(), visibility: 'private' } });
    await audit(staff, 'Image deleted', lot, { before: { id: mediaId, name: image.name } });
    return { reference: ref, images: mediaView(lot), documents: documentsView(lot) };
  }
  const doc = lot.documents.find((d) => d._id === mediaId);
  if (!doc) throw notFound('lot/media-not-found', 'That image or document is not on this lot.');
  lot.documents = lot.documents.filter((d) => d._id !== mediaId) as typeof lot.documents;
  lot.version = (lot.version ?? 0) + 1;
  await lot.save();
  const ids = [doc.fileId, ...(doc.history ?? []).map((h) => h.fileId)].filter((id): id is string => Boolean(id));
  if (ids.length) await FileModel.updateMany({ _id: { $in: ids } }, { $set: { deletedAt: new Date() } });
  await audit(staff, 'Document deleted', lot, { before: { id: mediaId, name: doc.name } });
  return { reference: ref, images: mediaView(lot), documents: documentsView(lot) };
}

export async function downloadLotMedia(ref: string, mediaId: string) {
  const lot = await ProductModel.findOne({ reference: ref }).lean<IProduct>();
  if (!lot) throw notFound('lot/not-found', 'Lot not found');
  const fileId = lot.media.find((m) => m._id === mediaId)?.fileId ?? lot.documents.find((d) => d._id === mediaId)?.fileId;
  if (!fileId) throw notFound('lot/media-not-found', 'That file is not stored in the platform.');
  const file = await FileModel.findOne({ _id: fileId, deletedAt: null }).lean();
  if (!file || !file.bytes) throw notFound('lot/media-not-found', 'The stored file is missing.');
  const data = await readFile(absoluteStoragePath(file.storageKey));
  return { id: mediaId, fileId, filename: file.filename, contentType: file.contentType, bytes: data.length, contentBase64: data.toString('base64') };
}

// ---------------------------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------------------------

type LotUnit = 'g' | 'kg' | 't';

function lotUnitOf(lot: Pick<IProduct, 'qty' | 'availableGrams'>): LotUnit {
  const unit = lot.qty?.unit;
  if (unit === 'g' || unit === 'kg' || unit === 't') return unit;
  return lot.availableGrams >= 1000 ? 'kg' : 'g';
}

const gramsPer = (unit: LotUnit) => GRAMS_PER_UNIT[unit];

export async function adjustLotStock(
  ref: string,
  input: {
    /** Signed grams to add (positive) or remove (negative). */
    deltaGrams?: number;
    /** Counted amount, in `unit` (default: the lot's unit). */
    avail?: number;
    unit?: LotUnit;
    reason: string;
    kind?: 'add' | 'remove' | 'count';
  },
  staff: LotStaff,
) {
  const reason = input.reason.trim();
  if (reason.length < 3) throw unprocessable('Say why the stock changed.', { reason: 'Required' });
  const hasDelta = input.deltaGrams !== undefined;
  const hasAvail = input.avail !== undefined;
  if (hasDelta === hasAvail) throw unprocessable('Send either deltaGrams or avail.', { deltaGrams: 'Choose one', avail: 'Choose one' });

  const lot = await ProductModel.findOne({ reference: ref }).lean<IProduct>();
  if (!lot) throw notFound('lot/not-found', 'Lot not found');
  const before = lot.availableGrams;
  const unit = lotUnitOf(lot);
  let after: number;
  let kind = input.kind;
  if (hasDelta) {
    if (!Number.isSafeInteger(input.deltaGrams) || input.deltaGrams === 0) throw unprocessable('deltaGrams must be a non-zero whole number of grams.', { deltaGrams: 'Invalid' });
    after = before + input.deltaGrams!;
    kind ??= input.deltaGrams! > 0 ? 'add' : 'remove';
  } else {
    if (!(input.avail! >= 0)) throw unprocessable('The counted amount must be zero or more.', { avail: 'Invalid' });
    after = Math.round(input.avail! * gramsPer(input.unit ?? unit));
    kind ??= 'count';
  }
  if (!Number.isSafeInteger(after)) throw unprocessable('That quantity is too large.', { avail: 'Invalid' });
  if (after < 0) throw conflict('lot/insufficient-stock', 'You cannot remove more than the quantity available.', { details: { availableGrams: before } });
  if (after === before) throw unprocessable('That leaves the stock unchanged.', { avail: 'No change' });

  const set: Record<string, unknown> = { availableGrams: after };
  if (lot.qty) set['qty.base'] = after * 1000;
  let status = lot.status;
  if (after === 0 && lot.status === 'active') status = 'sold';
  if (after > 0 && lot.status === 'sold') status = 'active';
  if (status !== lot.status) set.status = status;
  // Compare-and-set: a concurrent order or adjustment changes `availableGrams` and this matches nothing.
  const res = await ProductModel.updateOne({ _id: lot._id, availableGrams: before }, { $set: set, $inc: { version: 1 } });
  if (res.modifiedCount !== 1) throw conflict('lot/stock-changed', 'The stock changed while you were editing. Refresh and try again.');

  const per = gramsPer(unit);
  await audit(staff, 'Stock adjusted', lot, {
    before: { availableGrams: before },
    after: { availableGrams: after, deltaGrams: after - before, delta: +((after - before) / per).toFixed(6), unit, kind, status },
    reason,
  });
  return {
    reference: ref,
    availableGrams: after,
    previousGrams: before,
    deltaGrams: after - before,
    avail: +(after / per).toFixed(6),
    unit,
    status,
    reason,
  };
}

const MOVE_LABEL: Record<string, string> = { add: 'Stock added', remove: 'Stock removed', count: 'Count corrected' };

/** Stock adjustments, newest first, in the console's `moves` shape. */
export async function consoleStockMoves(limit = 300) {
  const rows = await AuditLog.find({ 'record.type': 'Lot', action: 'Stock adjusted' }).sort({ at: -1 }).limit(limit).lean<
    { at: Date; record: { id: string }; actor?: { name?: string }; reason?: string; after?: { delta?: number; kind?: string } }[]
  >();
  return rows.map((row) => ({
    at: new Date(row.at).getTime(),
    lot: row.record.id,
    delta: Number(row.after?.delta ?? 0),
    type: MOVE_LABEL[row.after?.kind ?? ''] ?? 'Stock adjusted',
    ref: '',
    by: row.actor?.name || 'System',
    note: row.reason || '',
  }));
}
