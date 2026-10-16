import { AppError, unprocessable } from '../../../common/errors/app-error.js';
import { SettingsDoc } from '../../../models/platform.models.js';

export type PlatformSettingDef = {
  key: string;
  label: string;
  description: string;
  unit: 'percent' | 'hours' | 'days' | 'kg';
  min: number;
  max: number;
  default: number;
};

export const PLATFORM_SETTING_DEFS: PlatformSettingDef[] = [
  { key: 'instant_estimate_tolerance_pct', label: 'Instant estimate tolerance', description: 'Variance allowed before a firm offer needs desk approval', unit: 'percent', min: 0, max: 10, default: 3 },
  { key: 'assay_variance_flag_pct', label: 'Assay variance flag', description: 'Assay vs declared variance that flags an order for review', unit: 'percent', min: 0, max: 10, default: 3 },
  { key: 'firm_offer_validity_hours', label: 'Firm offer validity', description: 'How long a firm offer stays open to the seller', unit: 'hours', min: 1, max: 168, default: 48 },
  { key: 'kyc_review_sla_hours', label: 'KYC review SLA', description: 'Target time to review a KYC submission', unit: 'hours', min: 1, max: 240, default: 48 },
  { key: 'document_expiry_escalation_days', label: 'Document expiry escalation', description: 'Days before expiry that a document is escalated', unit: 'days', min: 1, max: 180, default: 30 },
  { key: 'default_bid_increment_pct', label: 'Default bid increment', description: 'Suggested auction increment as % of the starting bid', unit: 'percent', min: 0.1, max: 10, default: 1 },
  { key: 'rate_override_max_deviation_pct', label: 'Manual rate deviation limit', description: 'Manual desk rate may differ from the feed by this much without explicit confirmation', unit: 'percent', min: 0, max: 50, default: 15 },
  { key: 'tier1_order_cap_kg', label: 'Tier 1 order cap', description: 'Maximum quantity per desk-entered order for Tier 1 accounts', unit: 'kg', min: 0, max: 100000, default: 25 },
  { key: 'tier2_order_cap_kg', label: 'Tier 2 order cap', description: 'Maximum quantity per desk-entered order for Tier 2 accounts', unit: 'kg', min: 0, max: 1000000, default: 500 },
  { key: 'lot_held_alert_days', label: 'Lot held alert', description: 'Alert when a lot has been held this long', unit: 'days', min: 1, max: 365, default: 45 },
];

export async function ensureSettings(key: 'roles' | 'platform' | 'btc') {
  const doc = await SettingsDoc.findOneAndUpdate({ key }, { $setOnInsert: { key, values: {}, version: 1 } }, { upsert: true, new: true }).lean();
  return doc!;
}

export const settingsEtag = (prefix: string, version: number) => `W/"${prefix}-${version}"`;

export async function getPlatformValues(): Promise<Record<string, number>> {
  const doc = await ensureSettings('platform');
  const stored = (doc.values ?? {}) as Record<string, number>;
  return Object.fromEntries(PLATFORM_SETTING_DEFS.map((d) => [d.key, stored[d.key] ?? d.default]));
}

export async function platformSetting(key: string): Promise<number> {
  const def = PLATFORM_SETTING_DEFS.find((d) => d.key === key);
  if (!def) throw new AppError({ status: 500, code: 'server/internal', message: `Unknown platform setting ${key}` });
  return (await getPlatformValues())[key]!;
}

export function validatePlatformValues(values: Record<string, unknown>): Record<string, number> {
  const fields: Record<string, string> = {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) {
    const def = PLATFORM_SETTING_DEFS.find((d) => d.key === k);
    if (!def) fields[k] = 'Unknown setting';
    else if (typeof v !== 'number' || !Number.isFinite(v)) fields[k] = 'Must be a number';
    else if (v < def.min || v > def.max) fields[k] = `Must be between ${def.min} and ${def.max}`;
    else out[k] = v;
  }
  if (Object.keys(fields).length) throw unprocessable('Validation failed', fields);
  return out;
}
