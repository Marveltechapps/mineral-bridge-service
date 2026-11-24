/**
 * BUG-022: Admin drawers render ID front, ID back and company documents, and a missing file as "unavailable".
 * @tags bugfix admin kyc
 */
import { describe, expect, it } from 'vitest';
import { kycDocPreview } from '../../../MB-Dashboard/src/modules/console/engine/kycDocs.ts';

describe('bugfix admin kyc BUG-022 document preview', () => {
  it('bug_022_renders_front_back_and_company_documents', () => {
    const front = kycDocPreview({ kind: 'idFront', url: '/v2/admin/files/fil_front/content', availability: 'ready' });
    const back = kycDocPreview({ kind: 'idBack', url: '/v2/admin/files/fil_back/content', availability: 'ready' });
    const company = kycDocPreview({ kind: 'business', name: 'company-registration.pdf', url: '/v2/admin/files/fil_biz/content', availability: 'ready' });
    expect(front.img).toContain('fil_front');
    expect(back.img).toContain('fil_back');
    expect(company.img).toContain('fil_biz');
    expect(front.ph).toBe('');
    expect(back.ph).toBe('');
    expect(company.ph).toBe('');
  });

  it('bug_022_missing_file_is_unavailable_not_a_broken_image', () => {
    const missing = kycDocPreview({ kind: 'address', url: '/v2/admin/files/fil_gone/content', availability: 'unavailable' });
    expect(missing).toEqual({ img: '', ph: 'unavailable' });
  });

  it('bug_022_demo_scan_placeholder_unchanged_when_no_upload_exists', () => {
    expect(kycDocPreview({ kind: 'idFront' })).toEqual({ img: '', ph: 'SCAN' });
    expect(kycDocPreview({ kind: 'business', name: 'registration.pdf' })).toEqual({ img: '', ph: 'PDF' });
  });
});
