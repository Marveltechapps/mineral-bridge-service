import { conflict, notFound } from '../../common/errors/app-error.js';
import { now } from '../../common/utils/clock.js';
import { UserDocumentModel } from '../../models/document.model.js';
import type { IUserDocument } from '../../models/document.model.js';
import { uploadsService } from '../uploads/uploads.service.js';

export const DOC_KINDS = ['national_id', 'passport', 'drivers_licence', 'proof_of_address', 'business_registration', 'export_permit', 'import_permit', 'mining_licence', 'tax_certificate', 'other'] as const;

export const documentsService = {
  async list(ownerId: string, skip: number, limit: number, kind?: string) {
    const filter = { ownerId, deletedAt: { $exists: false }, ...(kind ? { kind } : {}) };
    const [rows, total] = await Promise.all([
      UserDocumentModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean<IUserDocument[]>(),
      UserDocumentModel.countDocuments(filter),
    ]);
    return { rows, total };
  },

  async get(ownerId: string, id: string): Promise<IUserDocument> {
    const d = await UserDocumentModel.findOne({ _id: id, ownerId, deletedAt: { $exists: false } }).lean<IUserDocument>();
    if (!d) throw notFound('document/not-found', 'Document not found');
    return d;
  },

  async create(ownerId: string, input: { name: string; kind: string; fileId: string; issuedAt?: string; expiresAt?: string }) {
    const file = await uploadsService.owned(ownerId, input.fileId);
    const doc = await UserDocumentModel.create({
      ownerId,
      name: input.name,
      kind: input.kind,
      fileId: file._id,
      contentType: file.contentType,
      bytes: file.bytes,
      status: 'uploaded',
      issuedAt: input.issuedAt ? new Date(input.issuedAt) : undefined,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
    });
    return doc.toObject() as IUserDocument;
  },

  async update(ownerId: string, id: string, patch: { name?: string; expiresAt?: string | null }) {
    const d = await this.get(ownerId, id);
    if (d.status === 'verified' || d.status === 'in_review') throw conflict('document/locked', 'This document is under review or verified and cannot be edited.');
    const set: Record<string, unknown> = {};
    if (patch.name) set.name = patch.name;
    if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt ? new Date(patch.expiresAt) : null;
    await UserDocumentModel.updateOne({ _id: id, ownerId }, { $set: set });
    return this.get(ownerId, id);
  },

  /** Replace file (and optional metadata); resets review status to uploaded. */
  async replace(ownerId: string, id: string, input: { fileId?: string; name?: string; kind?: string; issuedAt?: string; expiresAt?: string }) {
    const d = await this.get(ownerId, id);
    if (d.status === 'in_review') throw conflict('document/locked', 'This document is under review and cannot be replaced.');
    const set: Record<string, unknown> = { status: 'uploaded', reviewerNotes: null };
    if (input.name) set.name = input.name;
    if (input.kind) set.kind = input.kind;
    if (input.issuedAt) set.issuedAt = new Date(input.issuedAt);
    if (input.expiresAt) set.expiresAt = new Date(input.expiresAt);
    if (input.fileId) {
      const file = await uploadsService.owned(ownerId, input.fileId);
      set.fileId = file._id;
      set.contentType = file.contentType;
      set.bytes = file.bytes;
    }
    await UserDocumentModel.updateOne({ _id: id, ownerId }, { $set: set });
    return this.get(ownerId, id);
  },

  async remove(ownerId: string, id: string) {
    const d = await this.get(ownerId, id);
    if (d.status === 'in_review') throw conflict('document/locked', 'This document is under review and cannot be deleted.');
    await UserDocumentModel.updateOne({ _id: id, ownerId }, { $set: { deletedAt: now() } });
  },
};
