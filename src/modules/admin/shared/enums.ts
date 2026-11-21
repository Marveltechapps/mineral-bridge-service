export const ORDER_STAGES = [
  'verification',
  'pricing_confirmation',
  'agent_visit',
  'inspection_approval',
  'payment_released',
  'custody_transfer',
] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];
export const ORDER_STAGE_LABEL: Record<OrderStage, string> = {
  verification: 'Verification',
  pricing_confirmation: 'Pricing confirmation',
  agent_visit: 'Agent visit',
  inspection_approval: 'Inspection & approval',
  payment_released: 'Payment released',
  custody_transfer: 'Custody transfer',
};

export const LOT_STATUSES = ['listed', 'in_vault', 'in_auction', 'reserved', 'shipped'] as const;
export const LISTING_STATUSES = ['live', 'paused', 'scheduled', 'sold_out', 'draft', 'ended'] as const;
export const BUYER_ACCESS = ['all_verified', 'tier3_only', 'tier2_plus'] as const;
export const AUCTION_STATUSES = ['draft', 'upcoming', 'live', 'paused', 'ended', 'cancelled'] as const;
export const LC_STAGES = ['requested', 'issued', 'shipped', 'docs_presented', 'paid'] as const;
export const AMENDMENT_TYPES = ['extend_expiry', 'change_amount', 'change_latest_shipment', 'change_documents', 'other'] as const;
export const NEGOTIATION_STATUSES = ['awaiting_miner', 'awaiting_trader', 'terms_agreed', 'stalled', 'contracted'] as const;
export const CHAIN_EVENT_TYPES = ['passport_mint', 'custody_transfer', 'lc_event', 'btc_settlement', 'bitcoin_anchor'] as const;
export const ACCOUNT_STATUSES = ['verified', 'in_review', 'expiring', 'rejected', 'suspended'] as const;
export const KYC_STATUSES = ['in_review', 'expiring_docs', 'verified', 'awaiting_resubmission', 'rejected'] as const;
export const KYC_OPEN_STATUSES = ['in_review', 'expiring_docs', 'awaiting_resubmission'] as const;
export const DOC_STATUSES = ['verified', 'in_review', 'expiring', 'expired', 'rejected'] as const;
export const DISPUTE_STATUSES = ['evidence_review', 'compliance_hold', 'awaiting_counterparty', 'resolved'] as const;
export const DISPUTE_OUTCOMES = ['independent_reassay', 'settlement_adjusted', 'credit_issued', 'claim_rejected'] as const;
export const EXCEPTION_TYPES = [
  'quantity_variance',
  'grade_variance',
  'document_issue',
  'seal_tampered',
  'counterparty_unreachable',
  'other',
] as const;
export const BANNER_PLACEMENTS = [
  'homepage_hero',
  'homepage_secondary',
  'in_app_promo',
  'category_miners',
  'category_buyers',
  'email_strip',
] as const;
export const BANNER_KINDS = ['hero', 'secondary', 'promo_card', 'category', 'email'] as const;
/** Legacy partner types kept during migration; new canonical values also accepted. */
export const PARTNER_TYPES = [
  'bonded_carrier',
  'inspection_hub',
  'lab_assay',
  'logistics',
  'inspection_agency',
  'inspector',
  'lab',
] as const;
export const PARTNER_STATUSES = ['onboarding', 'active', 'under_review', 'suspended'] as const;
export const TICKET_STATUSES = ['open', 'escalated', 'waiting_on_user', 'resolved'] as const;
export const AUDIT_CATEGORIES = [
  'pricing',
  'compliance',
  'orders',
  'vault',
  'roles_access',
  'content',
  'auth',
  'financial',
  'customers',
  'catalogue',
  'inspections',
  'logistics',
  'payments',
  'refunds',
  'support',
  'documents',
  'settings',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export const SETTLEMENT_KINDS = [
  'buy_settlement',
  'seller_payout',
  'auction_settlement',
  'btc_settlement',
  'refund',
] as const;
export const SETTLEMENT_STATUSES = ['released', 'on_hold', 'disputed', 'pending'] as const;

export const LABELS = {
  exceptionTypes: [
    ['quantity_variance', 'Quantity variance'],
    ['grade_variance', 'Grade variance'],
    ['document_issue', 'Document issue'],
    ['seal_tampered', 'Seal tampered'],
    ['counterparty_unreachable', 'Counterparty unreachable'],
    ['other', 'Other'],
  ],
  amendmentTypes: [
    ['extend_expiry', 'Extend expiry'],
    ['change_amount', 'Change amount'],
    ['change_latest_shipment', 'Change latest shipment date'],
    ['change_documents', 'Change documents'],
    ['other', 'Other'],
  ],
  disputeOutcomes: [
    ['independent_reassay', 'Independent re-assay ordered'],
    ['settlement_adjusted', 'Settlement adjusted'],
    ['credit_issued', 'Credit issued to counterparty'],
    ['claim_rejected', 'Claim rejected'],
  ],
  bannerPlacements: [
    ['homepage_hero', 'Homepage hero'],
    ['homepage_secondary', 'Homepage secondary'],
    ['in_app_promo', 'In-app promo'],
    ['category_miners', 'Category · miners'],
    ['category_buyers', 'Category · buyers'],
    ['email_strip', 'Email strip'],
  ],
  partnerTypes: [
    ['bonded_carrier', 'Bonded carrier'],
    ['inspection_hub', 'Inspection hub'],
    ['lab_assay', 'Assay lab'],
    ['logistics', 'Logistics'],
    ['inspection_agency', 'Inspection agency'],
    ['inspector', 'Inspector'],
    ['lab', 'Lab'],
  ],
  buyerAccess: [
    ['all_verified', 'All verified'],
    ['tier3_only', 'Tier 3 only'],
    ['tier2_plus', 'Tier 2+'],
  ],
} as const;

export const MS_DAY = 86_400_000;
export const MS_HOUR = 3_600_000;
