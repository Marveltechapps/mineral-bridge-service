import { EventEmitter } from 'node:events';
import type { KycRejection } from './kyc.types.js';

export interface KycSubmittedEvent {
  userId: string;
  submissionId: string;
  reference: string;
  source: 'mobile' | 'web';
}

export interface KycDecidedEvent {
  userId: string;
  submissionId: string;
  reference?: string;
  status: 'verified' | 'rejected' | 'resubmission_required';
  rejection?: KycRejection;
  decidedBy: string;
  notifyOnDecision: boolean;
}

interface KycEventMap {
  'kyc.submitted': [KycSubmittedEvent];
  'kyc.decided': [KycDecidedEvent];
}

/**
 * Domain events (ARCHITECTURE §5.3). The notifications / realtime layer subscribes later:
 * web R3 delivers `kyc.decided` on the notification stream, mobile gets a push.
 */
class KycEvents extends EventEmitter<KycEventMap> {}

export const kycEvents = new KycEvents();
