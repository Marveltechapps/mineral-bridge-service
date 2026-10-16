import type { ApiClient } from '../middleware/request-context.js';

export type AuthActor =
  | {
      kind: 'user';
      userId: string;
      roles: string[];
      /** Canonical KYC status (none | pending | verified | rejected). Mappers translate per client. */
      kycStatus: string;
      tier?: number;
      /** Public session id (`ses_…`). */
      sessionId: string;
      /** Client the access token was minted for (`cli` claim) — authoritative over headers. */
      client: 'mobile' | 'web';
    }
  | {
      kind: 'staff';
      staffId: string;
      role: string;
      permissions: Record<string, 'none' | 'view' | 'edit'>;
      /** Public session id (`SES-…`). */
      sessionId: string;
      sessionState: 'active' | 'locked';
      /** sha256 of the CSRF token bound to this session (the plaintext is never stored). */
      csrfTokenHash: string;
    };

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      apiClient: ApiClient;
      actor?: AuthActor;
      idempotencyKey?: string;
    }
  }
}

export {};
