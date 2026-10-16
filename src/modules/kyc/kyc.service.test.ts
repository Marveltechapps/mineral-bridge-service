import { describe, expect, it } from 'vitest';
import { getIdType, idTypeFromWeb, normalizeIdNumber, requiredWebSides } from './kyc.id-types.js';
import { sniffMime, validateKycUpload } from './kyc.file-store.js';
import {
  deriveWebStage,
  hasPassedSelfie,
  kindForWebSide,
  missingCaptureKinds,
  requiresManualReview,
  submissionBlock,
  webSideForKind,
} from './kyc.service.js';

const nin = getIdType('nin')!;
const passport = getIdType('passport')!;

type Doc = Parameters<typeof missingCaptureKinds>[1][number];
const doc = (kind: Doc['kind'], over: Partial<Doc> = {}): Doc =>
  ({ kind, discardedAt: undefined, quality: { passed: true }, liveness: undefined, ...over }) as Doc;

describe('submissionBlock', () => {
  it('blocks pending and verified users from editing/submitting', () => {
    expect(submissionBlock('pending')).toBe('already_pending');
    expect(submissionBlock('verified')).toBe('already_verified');
  });
  it('lets none and rejected users (re)submit', () => {
    expect(submissionBlock('none')).toBeNull();
    expect(submissionBlock('rejected')).toBeNull();
  });
});

describe('requiresManualReview (M-18)', () => {
  it('flips after the third attempt', () => {
    expect(requiresManualReview(1)).toBe(false);
    expect(requiresManualReview(3)).toBe(false);
    expect(requiresManualReview(4)).toBe(true);
  });
});

describe('missingCaptureKinds', () => {
  it('needs front only when no ID type is chosen', () => {
    expect(missingCaptureKinds(undefined, [])).toEqual(['id_front']);
  });
  it('needs front and back for NIN, front only for a passport', () => {
    expect(missingCaptureKinds(nin, [])).toEqual(['id_front', 'id_back']);
    expect(missingCaptureKinds(passport, [])).toEqual(['id_front']);
  });
  it('ignores discarded and unreadable captures', () => {
    const docs = [doc('id_front', { discardedAt: new Date() }), doc('id_back', { quality: { passed: false } as Doc['quality'] })];
    expect(missingCaptureKinds(nin, docs)).toEqual(['id_front', 'id_back']);
  });
  it('is empty when every side is readable', () => {
    expect(missingCaptureKinds(nin, [doc('id_front'), doc('id_back')])).toEqual([]);
  });
});

describe('selfie', () => {
  it('needs a readable, non-failed liveness selfie', () => {
    expect(hasPassedSelfie([])).toBe(false);
    expect(hasPassedSelfie([doc('selfie')])).toBe(true);
    expect(hasPassedSelfie([doc('selfie', { liveness: { passed: false } as Doc['liveness'] })])).toBe(false);
    expect(hasPassedSelfie([doc('selfie', { discardedAt: new Date() })])).toBe(false);
  });
});

describe('deriveWebStage', () => {
  it('walks type -> capture -> live -> review', () => {
    expect(deriveWebStage('none', undefined, [])).toBe('type');
    expect(deriveWebStage('none', nin, [doc('id_front')])).toBe('capture');
    expect(deriveWebStage('none', nin, [doc('id_front'), doc('id_back')])).toBe('live');
    expect(deriveWebStage('none', nin, [doc('id_front'), doc('id_back'), doc('selfie')])).toBe('review');
  });
  it('shows pending for pending and verified accounts', () => {
    expect(deriveWebStage('pending', nin, [])).toBe('pending');
    expect(deriveWebStage('verified', nin, [])).toBe('pending');
  });
  it('restarts at the right stage after a rejection', () => {
    expect(deriveWebStage('rejected', undefined, [])).toBe('type');
  });
});

describe('web side mapping', () => {
  it('stores a passport photo page as id_front', () => {
    expect(kindForWebSide('photo_page')).toBe('id_front');
    expect(kindForWebSide('front')).toBe('id_front');
    expect(kindForWebSide('back')).toBe('id_back');
    expect(webSideForKind('id_front', passport)).toBe('photo_page');
    expect(webSideForKind('id_front', nin)).toBe('front');
    expect(webSideForKind('id_back', nin)).toBe('back');
    expect(webSideForKind('selfie', nin)).toBeNull();
  });
  it('requiredSides is computed server-side', () => {
    expect(requiredWebSides(passport)).toEqual(['photo_page']);
    expect(requiredWebSides(nin)).toEqual(['front', 'back']);
    expect(requiredWebSides(undefined)).toEqual([]);
  });
  it('translates web ID type ids', () => {
    expect(idTypeFromWeb('national')?.id).toBe('nin');
    expect(idTypeFromWeb('licence')?.id).toBe('drivers_licence');
    expect(idTypeFromWeb('voters_card')).toBeUndefined();
  });
});

describe('normalizeIdNumber', () => {
  it('strips spaces and upper-cases', () => {
    expect(normalizeIdNumber(nin, '2213 4477 901')).toBe('22134477901');
    expect(normalizeIdNumber(passport, 'a501 88274')).toBe('A50188274');
  });
  it('returns null for numbers that do not fit', () => {
    expect(normalizeIdNumber(nin, '1234')).toBeNull();
    expect(normalizeIdNumber(passport, '123456789')).toBeNull();
  });
});

describe('upload validation', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

  it('sniffs the real type from magic bytes, not the filename', () => {
    expect(sniffMime(jpeg)).toBe('image/jpeg');
    expect(sniffMime(png)).toBe('image/png');
    expect(sniffMime(Buffer.from('<?php echo 1; ?>'))).toBeNull();
  });

  it('rejects unsupported types with document/unsupported-type', () => {
    expect(() => validateKycUpload('id_front', Buffer.from('hello world, not an image'))).toThrowError(
      expect.objectContaining({ status: 422, code: 'document/unsupported-type' }) as unknown as Error,
    );
  });

  it('rejects oversize files with document/too-large', () => {
    const big = Buffer.concat([jpeg, Buffer.alloc(12 * 1024 * 1024)]);
    expect(() => validateKycUpload('id_front', big)).toThrowError(
      expect.objectContaining({ status: 422, code: 'document/too-large' }) as unknown as Error,
    );
  });

  it('accepts a small jpeg', () => {
    expect(validateKycUpload('id_front', jpeg)).toBe('image/jpeg');
  });
});
