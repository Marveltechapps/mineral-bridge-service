import type { KycDocKind, KycQualityIssue } from './kyc.types.js';

export interface DocumentAssessment {
  passed: boolean;
  issues: KycQualityIssue[];
}

export interface SelfieAssessment {
  passed: boolean;
  faceDetected: boolean;
  /** 0–1. `0` with `automated: false` means "not scored". */
  score: number;
  reason?: string;
}

export interface KycVerificationProvider {
  readonly name: string;
  /** `false` ⇒ nothing was checked automatically; a compliance officer reviews every submission. */
  readonly automated: boolean;
  assessDocument(input: {
    kind: Exclude<KycDocKind, 'selfie'>;
    mimeType?: string;
    sizeBytes?: number;
    buffer?: Buffer;
  }): Promise<DocumentAssessment>;
  assessSelfie(input: {
    mimeType?: string;
    sizeBytes?: number;
    buffer?: Buffer;
    livenessToken?: string;
  }): Promise<SelfieAssessment>;
}

/**
 * Default when `IDENTITY_PROVIDER` is unset: no automated glare/blur/liveness analysis. Every
 * upload passes the automated stage and the submission goes to human review. This is honest
 * rather than a fake "score 0.97" — the real provider (Smile ID, Onfido, …) plugs in here.
 */
export class ManualReviewProvider implements KycVerificationProvider {
  readonly name = 'manual-review';
  readonly automated = false;

  async assessDocument(): Promise<DocumentAssessment> {
    return { passed: true, issues: [] };
  }

  async assessSelfie(): Promise<SelfieAssessment> {
    return { passed: true, faceDetected: true, score: 0 };
  }
}

let current: KycVerificationProvider = new ManualReviewProvider();

export function getKycProvider(): KycVerificationProvider {
  return current;
}

/** Test seam / production wiring. */
export function setKycProvider(provider: KycVerificationProvider): void {
  current = provider;
}
