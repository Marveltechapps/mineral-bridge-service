import type { Router } from 'express';
import { createCustomerAuthRouter } from '../../modules/auth/customer.routes.js';

/**
 * Shared auth paths (/auth/otp/{request,verify,resend}, DELETE /auth/account, GET /auth/sessions,
 * DELETE /auth/sessions/:id). The auth module owns the contracts and already dispatches on
 * eq.apiClient; this adapter only places it in the shared aggregator.
 */
export function authSharedRouter(): Router {
  return createCustomerAuthRouter();
}
