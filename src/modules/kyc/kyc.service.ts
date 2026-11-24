import { randomInt } from 'node:crypto';
import { isValidObjectId, Types } from 'mongoose';
import { AppError, conflict, unprocessable } from '../../common/errors/app-error.js';
import { IdPrefixes, opaqueId } from '../../common/utils/ids.js';
import { isDuplicateKeyError } from '../users/user.repository.js';
import { applyKycStatus, getUserOrThrow } from '../users/user.service.js';
import type { KycStatus, Tier, UserRecord } from '../users/user.types.js';
import {
  getIdType,
  normalizeIdNumber,
  type KycIdType,
  type WebSide,
} from './kyc.id-types.js';
import { projectKycSubmission, safeProject } from '../../integration/customer-admin.bridge.js';
import { kycEvents } from './kyc.events.js';
import { getKycFileResolver } from './kyc.file-store.js';
import { KycDocumentModel, KycSubmissionModel } from './kyc.model.js';
import { getKycProvider } from './kyc.provider.js';
import {
  KYC_AUTO_RETRY_LIMIT,
  KYC_WEB_REVIEW_SLA_HOURS,
  type KycDocKind,
  type KycDocumentRecord,
  type KycDocumentShape,
  type KycSource,
  type KycSubmissionRecord,
  type KycSubmissionShape,
} from './kyc.types.js';

type WithId<T> = T & { _id: { toString(): string } };

function docRecord(raw: WithId<KycDocumentShape> | null): KycDocumentRecord | null {
  if (!raw) return null;
  const { _id, ...rest } = raw as WithId<KycDocumentShape> & Record<string, unknown>;
  return { ...(rest as unknown as KycDocumentShape), id: _id.toString() };
}

function subRecord(raw: WithId<KycSubmissionShape> | null): KycSubmissionRecord | null {
  if (!raw) return null;
  const { _id, ...rest } = raw as WithId<KycSubmissionShape> & Record<string, unknown>;
  return { ...(rest as unknown as KycSubmissionShape), id: _id.toString() };
}

// =============================================================================================
// Pure rules (unit-tested without a database)
// =============================================================================================

/** A user may start/modify a submission unless one is already under review or approved. */
export function submissionBlock(status: KycStatus): 'already_pending' | 'already_verified' | null {
  if (status === 'pending') return 'already_pending';
  if (status === 'verified') return 'already_verified';
  return null;
}

/** Web side → stored kind. A passport's photo page is stored as `id_front`. */
export function kindForWebSide(side: WebSide): Exclude<KycDocKind, 'selfie'> {
  return side === 'back' ? 'id_back' : 'id_front';
}

export function webSideForKind(kind: KycDocKind, idType: KycIdType | undefined): WebSide | null {
  if (kind === 'selfie' || kind === 'proof_of_address' || kind === 'business_registration') return null;
  if (kind === 'id_back') return 'back';
  return idType?.id === 'passport' ? 'photo_page' : 'front';
}

type DocView = Pick<KycDocumentShape, 'kind' | 'discardedAt' | 'quality' | 'liveness'>;

function activePassed(docs: readonly DocView[], kind: KycDocKind): boolean {
  return docs.some((d) => d.kind === kind && !d.discardedAt && d.quality.passed);
}

/** Which required capture kinds are missing (readable) for an ID type. */
export function missingCaptureKinds(
  idType: KycIdType | undefined,
  docs: readonly DocView[],
): Array<Exclude<KycDocKind, 'selfie'>> {
  // BUG-001: UI defaults to National ID (nin). Treat unset id type the same so id_back is required.
  const effective = idType ?? getIdType('nin');
  if (!effective) return ['id_front'];
  const need: Array<Exclude<KycDocKind, 'selfie'>> = effective.requiresBack ? ['id_front', 'id_back'] : ['id_front'];
  return need.filter((k) => !activePassed(docs, k));
}

/**
 * Document kinds required for a KYC draft/submission.
 * BUG-001: when the draft has no idTypeId yet, default to National ID (nin) — matching the
 * web/mobile UI default — so `id_back` is required and uploadable.
 */
const NON_BUSINESS_CUSTOMER_TYPES = new Set(['investor', 'asm', 'scrap']);

/** Same rule as web/mobile `isBusiness`: exempt types never need a business registration doc. */
export function customerNeedsBusinessKycDoc(user: Pick<UserRecord, 'roles' | 'business'>): boolean {
  const roles = user.roles ?? [];
  const types: string[] = [];
  if (roles.includes('buyer') || roles.includes('both')) {
    if (user.business?.buyerType) types.push(user.business.buyerType);
  }
  if (roles.includes('seller') || roles.includes('both')) {
    if (user.business?.sellerType) types.push(user.business.sellerType);
  }
  return types.some((t) => !NON_BUSINESS_CUSTOMER_TYPES.has(t));
}

export function requiredKycDocKinds(input: {
  idTypeId?: string | null;
  isBusiness?: boolean;
}): KycDocKind[] {
  const idType = getIdType(input.idTypeId) ?? getIdType('nin');
  const kinds: KycDocKind[] = ['id_front', 'selfie', 'proof_of_address'];
  if (idType?.requiresBack) kinds.splice(1, 0, 'id_back');
  if (input.isBusiness) kinds.push('business_registration');
  return kinds;
}

export function hasPassedSelfie(docs: readonly DocView[]): boolean {
  return docs.some((d) => d.kind === 'selfie' && !d.discardedAt && d.quality.passed && d.liveness?.passed !== false);
}

export type WebStage = 'type' | 'capture' | 'live' | 'review' | 'pending';

/** Server-side stage for web `GET /kyc` (`why` is client-only). */
export function deriveWebStage(
  userStatus: KycStatus,
  idType: KycIdType | undefined,
  docs: readonly DocView[],
): WebStage {
  if (userStatus === 'pending' || userStatus === 'verified') return 'pending';
  if (!idType) return 'type';
  if (missingCaptureKinds(idType, docs).length > 0) return 'capture';
  if (!hasPassedSelfie(docs)) return 'live';
  return 'review';
}

/** `attemptNumber` > 3 ⇒ manual review (M-18). */
export function requiresManualReview(attemptNumber: number): boolean {
  return attemptNumber > KYC_AUTO_RETRY_LIMIT;
}

// =============================================================================================
// Drafts & documents
// =============================================================================================

function guardEditable(user: UserRecord): void {
  const block = submissionBlock(user.kycStatus);
  if (block) {
    throw conflict(
      'kyc/already-submitted',
      block === 'already_pending'
        ? 'A verification is already in review.'
        : 'Your identity is already verified.',
    );
  }
}

export async function getDraft(userId: string): Promise<KycSubmissionRecord | null> {
  return subRecord(
    await KycSubmissionModel.findOne({ userId, status: 'draft' }).lean<WithId<KycSubmissionShape>>(),
  );
}

export async function ensureDraft(userId: string, source: KycSource): Promise<KycSubmissionRecord> {
  const filter = { userId: new Types.ObjectId(userId), status: 'draft' as const };
  const insert = {
    publicId: opaqueId(IdPrefixes.kyc),
    source,
    // BUG-001: match client default ("National ID") so id_back is required from the first GET.
    idTypeId: 'nin',
    documentIds: [],
    declaredDetails: {},
    consent: { given: false },
    attemptNumber: 0,
    manualReviewRequired: false,
    notifyOnDecision: false,
  };
  try {
    const doc = await KycSubmissionModel.findOneAndUpdate(
      filter,
      { $setOnInsert: insert },
      { upsert: true, new: true },
    ).lean<WithId<KycSubmissionShape>>();
    return subRecord(doc)!;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const existing = await getDraft(userId);
      if (existing) return existing;
    }
    throw err;
  }
}

export async function getLatestSubmission(userId: string): Promise<KycSubmissionRecord | null> {
  return subRecord(
    await KycSubmissionModel.findOne({ userId, status: { $ne: 'draft' } })
      .sort({ submittedAt: -1, createdAt: -1 })
      .lean<WithId<KycSubmissionShape>>(),
  );
}

/** Looks up by public id (`kyc_…`) or reference (`KYC-…`), scoped to the owner. */
export async function getSubmissionForUser(
  userId: string,
  idOrReference: string,
): Promise<KycSubmissionRecord | null> {
  return subRecord(
    await KycSubmissionModel.findOne({
      userId,
      status: { $ne: 'draft' },
      $or: [{ publicId: idOrReference }, { reference: idOrReference }],
    }).lean<WithId<KycSubmissionShape>>(),
  );
}

export async function listActiveDocuments(submissionId: string): Promise<KycDocumentRecord[]> {
  if (!isValidObjectId(submissionId)) return [];
  const rows = await KycDocumentModel.find({ submissionId, discardedAt: null })
    .sort({ uploadedAt: 1 })
    .lean<Array<WithId<KycDocumentShape>>>();
  return rows.map((r) => docRecord(r)!);
}

async function discardActive(
  submissionId: string,
  kinds: KycDocKind[],
  exceptDocId?: string,
): Promise<void> {
  await KycDocumentModel.updateMany(
    {
      submissionId,
      kind: { $in: kinds },
      discardedAt: null,
      ...(exceptDocId ? { _id: { $ne: exceptDocId } } : {}),
    },
    { $set: { discardedAt: new Date() } },
  );
}

/**
 * Sets the draft's ID type. A different type discards existing ID captures (not the selfie) —
 * web `PATCH /kyc`: "discards existing captures and returns the new `requiredSides`".
 */
export async function setDraftIdType(
  userId: string,
  idTypeId: string,
  source: KycSource,
): Promise<KycSubmissionRecord> {
  guardEditable(await getUserOrThrow(userId));
  const idType = getIdType(idTypeId);
  if (!idType) throw unprocessable('Unknown ID type.', { idType: 'Choose a supported ID type' });

  const draft = await ensureDraft(userId, source);
  if (draft.idTypeId === idTypeId) return draft;
  await discardActive(draft.id, ['id_front', 'id_back']);
  const updated = await KycSubmissionModel.findByIdAndUpdate(
    draft.id,
    { $set: { idTypeId } },
    { new: true },
  ).lean<WithId<KycSubmissionShape>>();
  return subRecord(updated)!;
}

export interface AddDocumentInput {
  userId: string;
  kind: KycDocKind;
  idTypeId?: string;
  fileId: string;
  mimeType?: string;
  sizeBytes?: number;
  originalName?: string;
  buffer?: Buffer;
  livenessToken?: string;
  source: KycSource;
  /**
   * Mobile: an unreadable document / failed selfie is an error and is not kept.
   * Web: it is stored as not-acceptable so the slot stays pending and can simply be re-posted.
   */
  rejectUnreadable: boolean;
}

export interface AddDocumentResult {
  document: KycDocumentRecord;
  kept: boolean;
}

export async function addDocument(input: AddDocumentInput): Promise<AddDocumentResult> {
  const user = await getUserOrThrow(input.userId);
  guardEditable(user);

  if (input.source === 'web') {
    const ok = await getKycFileResolver()(input.userId, input.fileId);
    if (!ok) throw unprocessable('That file cannot be used.', { fileId: 'Unknown or unusable file' });
    const elsewhere = await KycDocumentModel.exists({
      fileId: input.fileId,
      userId: { $ne: new Types.ObjectId(input.userId) },
    });
    if (elsewhere) throw unprocessable('That file cannot be used.', { fileId: 'Unknown or unusable file' });
  }

  let draft = await ensureDraft(input.userId, input.source);
  if (input.idTypeId && draft.idTypeId !== input.idTypeId) {
    if (!getIdType(input.idTypeId)) throw unprocessable('Unknown ID type.', { idTypeId: 'Choose a supported ID type' });
    draft = await setDraftIdType(input.userId, input.idTypeId, input.source);
  }

  const provider = getKycProvider();
  let quality: { passed: boolean; issues: KycDocumentShape['quality']['issues'] };
  let liveness: KycDocumentShape['liveness'];
  if (input.kind === 'selfie') {
    const a = await provider.assessSelfie({
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      buffer: input.buffer,
      livenessToken: input.livenessToken,
    });
    quality = { passed: a.passed, issues: [] };
    liveness = { passed: a.passed, faceDetected: a.faceDetected, score: a.score, reason: a.reason };
  } else {
    const a = await provider.assessDocument({
      kind: input.kind,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      buffer: input.buffer,
    });
    quality = { passed: a.passed, issues: a.issues };
  }

  const now = new Date();
  const discardImmediately = !quality.passed && input.rejectUnreadable;
  const created = await KycDocumentModel.create({
    publicId: opaqueId('kdoc'),
    userId: new Types.ObjectId(input.userId),
    submissionId: new Types.ObjectId(draft.id),
    kind: input.kind,
    idTypeId: input.idTypeId ?? draft.idTypeId,
    fileId: input.fileId,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    originalName: input.originalName?.slice(0, 255),
    quality,
    liveness,
    automated: provider.automated,
    source: input.source,
    uploadedAt: now,
    ...(discardImmediately ? { discardedAt: now } : {}),
  });
  const document = docRecord(created.toObject() as unknown as WithId<KycDocumentShape>)!;

  if (!discardImmediately) await discardActive(draft.id, [input.kind], document.id);
  return { document, kept: !discardImmediately };
}

export async function removeCapture(userId: string, side: WebSide): Promise<void> {
  guardEditable(await getUserOrThrow(userId));
  const draft = await getDraft(userId);
  if (!draft) return;
  await discardActive(draft.id, [kindForWebSide(side)]);
}

/** v2 KYC-04: remove by document kind. */
export async function removeDocumentKind(userId: string, kind: KycDocKind): Promise<void> {
  guardEditable(await getUserOrThrow(userId));
  const draft = await getDraft(userId);
  if (!draft) return;
  await discardActive(draft.id, [kind]);
}

// =============================================================================================
// Submission
// =============================================================================================

async function allocateReference(): Promise<string> {
  // `KYC-2026-77310`. Uniqueness is enforced by the index; the caller retries on collision.
  return `KYC-${new Date().getUTCFullYear()}-${randomInt(10_000, 100_000)}`;
}

async function finalizeSubmission(
  draft: KycSubmissionRecord,
  patch: Partial<KycSubmissionShape>,
  userId: string,
  source: KycSource,
): Promise<KycSubmissionRecord> {
  const prior = await KycSubmissionModel.countDocuments({ userId, status: { $ne: 'draft' } });
  const attemptNumber = prior + 1;
  const now = new Date();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reference = await allocateReference();
    try {
      const updated = await KycSubmissionModel.findOneAndUpdate(
        { _id: draft.id, status: 'draft' },
        {
          $set: {
            ...patch,
            status: 'pending',
            reference,
            source,
            attemptNumber,
            manualReviewRequired: requiresManualReview(attemptNumber),
            submittedAt: now,
            estimatedDecisionBy: new Date(now.getTime() + KYC_WEB_REVIEW_SLA_HOURS * 3_600_000),
          },
        },
        { new: true },
      ).lean<WithId<KycSubmissionShape>>();
      // Lost a race with a parallel submit of the same draft.
      if (!updated) throw conflict('kyc/already-submitted', 'A verification is already in review.');
      const submission = subRecord(updated)!;
      await applyKycStatus(userId, {
        status: 'pending',
        reference,
        submissionId: submission.id,
      });
      kycEvents.emit('kyc.submitted', { userId, submissionId: submission.id, reference, source });
      await safeProject('kyc', () => projectKycSubmission(submission, submission.declaredDetails.fullName));
      return submission;
    } catch (err) {
      if (isDuplicateKeyError(err)) continue; // reference collision — draw another
      throw err;
    }
  }
  throw new AppError({ status: 503, code: 'server/unavailable', message: 'Could not allocate a reference. Try again.' });
}

export interface MobileSubmitInput {
  userId: string;
  idTypeId: string;
  idNumber: string;
  documentIds: string[];
  tierId?: Tier;
  declaredDetails?: { fullName?: string; dateOfBirth?: string };
  consent: boolean;
  ip?: string;
}

/** Mobile `POST /kyc/submissions` (#25). */
export async function submitMobile(input: MobileSubmitInput): Promise<KycSubmissionRecord> {
  if (input.consent !== true) {
    throw unprocessable(
      'Consent is required to verify your identity.',
      { consent: 'You must agree to continue' },
      'kyc/consent-required',
    );
  }
  const user = await getUserOrThrow(input.userId);
  guardEditable(user);

  const idType = getIdType(input.idTypeId);
  if (!idType) throw unprocessable('Unknown ID type.', { idTypeId: 'Choose a supported ID type' });
  const idNumber = normalizeIdNumber(idType, input.idNumber);
  if (!idNumber) {
    throw unprocessable('That ID number is not in the expected format.', {
      idNumber: `Expected format like ${idType.numberFormat.example}`,
    });
  }

  const ids = input.documentIds.filter((id) => typeof id === 'string');
  const docs = (
    await KycDocumentModel.find({ publicId: { $in: ids }, userId: input.userId, discardedAt: null }).lean<
      Array<WithId<KycDocumentShape>>
    >()
  ).map((d) => docRecord(d)!);
  if (docs.length !== new Set(ids).size) {
    throw unprocessable('Some documents were not found.', { documentIds: 'Unknown or expired document' });
  }
  const missing = missingCaptureKinds(idType, docs);
  if (missing.length > 0 || !hasPassedSelfie(docs)) {
    throw unprocessable('Upload every required document first.', {
      documentIds: `Missing: ${[...missing, ...(hasPassedSelfie(docs) ? [] : ['selfie'])].join(', ')}`,
    });
  }

  const draft = await ensureDraft(input.userId, 'mobile');
  const now = new Date();
  const submission = await finalizeSubmission(
    draft,
    {
      idTypeId: idType.id,
      idNumber,
      idNumberLast4: idNumber.slice(-4),
      documentIds: docs.map((d) => new Types.ObjectId(d.id)),
      requestedTier: input.tierId,
      declaredDetails: input.declaredDetails ?? {},
      consent: { given: true, at: now, ip: input.ip },
    },
    input.userId,
    'mobile',
  );
  await KycDocumentModel.updateMany(
    { _id: { $in: docs.map((d) => d.id) } },
    { $set: { submissionId: new Types.ObjectId(submission.id) } },
  );
  return submission;
}

/** Web `POST /kyc/submit` (no body): the draft's captures + selfie are the submission. */
export async function submitWeb(input: { userId: string; ip?: string }): Promise<KycSubmissionRecord> {
  const user = await getUserOrThrow(input.userId);
  guardEditable(user);

  const draft = await getDraft(input.userId);
  const idType = getIdType(draft?.idTypeId);
  const docs = draft ? await listActiveDocuments(draft.id) : [];

  if (!draft || !idType || missingCaptureKinds(idType, docs).length > 0) {
    throw unprocessable(
      'Capture every side of your document first.',
      { captures: 'Incomplete' },
      'kyc/captures-incomplete',
    );
  }
  if (!hasPassedSelfie(docs)) {
    throw unprocessable('Take a selfie first.', { selfie: 'Missing or failed liveness' }, 'kyc/selfie-missing');
  }

  const now = new Date();
  return finalizeSubmission(
    draft,
    {
      documentIds: docs.map((d) => new Types.ObjectId(d.id)),
      declaredDetails: {
        fullName: user.profile.fullName,
        dateOfBirth: user.profile.dateOfBirth,
      },
      // The web flow's `review` step is the consent screen.
      consent: { given: true, at: now, ip: input.ip },
    },
    input.userId,
    'web',
  );
}

export async function setNotifyOnDecision(userId: string): Promise<void> {
  await KycSubmissionModel.updateOne(
    { userId, status: { $in: ['pending', 'in_review'] } },
    { $set: { notifyOnDecision: true } },
  );
}

// =============================================================================================
// Read models used by both clients
// =============================================================================================

export interface KycView {
  user: UserRecord;
  /** Most recent non-draft submission (pending / decided). */
  latest: KycSubmissionRecord | null;
  /** The in-progress draft, when the user is (re)starting. */
  draft: KycSubmissionRecord | null;
  /** The submission whose documents the client should see right now. */
  active: KycSubmissionRecord | null;
  documents: KycDocumentRecord[];
  /** Captures from the latest decided submission, so a rejection can be shown with its photos. */
  feedbackDocuments: KycDocumentRecord[];
}

export async function getKycView(userId: string): Promise<KycView> {
  const user = await getUserOrThrow(userId);
  const [latest, draft] = await Promise.all([getLatestSubmission(userId), getDraft(userId)]);
  const active = user.kycStatus === 'pending' || user.kycStatus === 'verified' ? latest : (draft ?? null);
  const documents = active ? await listActiveDocuments(active.id) : [];
  const needsFeedback =
    !!latest &&
    (user.kycStatus === 'rejected' || latest.status === 'rejected' || latest.status === 'resubmission_required');
  const feedbackDocuments =
    needsFeedback && latest && latest.id !== active?.id
      ? await listActiveDocuments(latest.id)
      : needsFeedback
        ? documents
        : [];
  return { user, latest, draft, active, documents, feedbackDocuments };
}

export async function getWebKycStage(userId: string): Promise<WebStage> {
  const view = await getKycView(userId);
  return deriveWebStage(view.user.kycStatus, getIdType(view.active?.idTypeId), view.documents);
}
