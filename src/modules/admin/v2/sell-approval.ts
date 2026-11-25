/** Sell final-approval checks. Pure so the workflow gate and the tests share one decision. */

export const LEGACY_SELL_CONDITION = 'Subject to Mineral Bridge inspection and SGS test report';
export const GENERIC_SELL_CONDITION = 'Subject to Mineral Bridge inspection and a third-party test report';

export function isNonCompliant(result: unknown) {
  const text = String(result ?? '').trim();
  if (!text || /with remarks/i.test(text)) return false;
  return /non[\s_-]*compliant/i.test(text);
}

export function humanQty(q?: { value?: number; base?: number } | null): number | null {
  if (!q) return null;
  if (q.value != null && Number.isFinite(Number(q.value))) return Number(q.value);
  if (q.base != null && Number.isFinite(Number(q.base))) return Number(q.base);
  return null;
}

export function quantitiesMatch(declared: number | null, actual: number | null) {
  if (declared == null || actual == null || !Number.isFinite(declared) || !Number.isFinite(actual)) return false;
  if (declared === 0) return actual === 0;
  return Math.abs(actual - declared) <= Math.max(0.0005, Math.abs(declared) * 0.0005);
}

function gradeKey(value: string) {
  return value.replace(/~/g, '').replace(/\s+/g, '').replace(/%/g, '').toLowerCase();
}

export function gradesMatch(declared: string, certified: string) {
  if (!certified) return true;
  return gradeKey(declared) === gradeKey(certified);
}

export function discrepancyResolved(timeline: { label?: string; note?: string }[]) {
  return timeline.some((row) => /^Discrepancy resolved\b/i.test(String(row?.note || row?.label || '')));
}

export function sellQuoteCondition(stored: string | undefined, agencyName?: string) {
  const agency = String(agencyName || '').split('·')[0].trim();
  const named = agency && agency !== '—' && agency !== 'Inspection' ? agency : '';
  const text = String(stored || '');
  if (named && (!text || text === LEGACY_SELL_CONDITION || text === GENERIC_SELL_CONDITION)) {
    return `Subject to Mineral Bridge inspection and ${named} test report`;
  }
  return text || GENERIC_SELL_CONDITION;
}

export interface SellApprovalInput {
  side?: string;
  declaredQty: number | null;
  declaredGrade: string;
  agencyName?: string;
  weighed: number | null;
  certifiedQty: number | null;
  report?: { no?: string; grade?: string; result?: string; remarks?: string } | null;
  holdType?: string | null;
  holdReason?: string | null;
  timeline: { label?: string; note?: string }[];
}

/** Reasons final approval and payout must stay blocked. An empty list means the checks passed. */
export function sellApprovalBlocks(input: SellApprovalInput): string[] {
  if (input.side && input.side !== 'sell') return [];
  const blocks: string[] = [];
  const agency = String(input.agencyName || '').trim();
  if (!agency || agency === '—' || agency === 'Inspection') blocks.push('An inspection agency has not been assigned.');
  if (input.weighed == null) blocks.push('The inspected quantity has not been recorded.');
  const report = input.report;
  if (!report?.no) blocks.push('The inspection report and certificate have not been uploaded.');
  else if (!String(report.result || '').trim()) blocks.push('The inspection report has no result.');
  if (report?.no && isNonCompliant(report.result)) {
    const remarks = String(report.remarks || '').trim();
    const grade = String(report.grade || '').trim();
    const why = remarks || (grade ? `grade ${grade}` : 'no remarks were recorded');
    blocks.push(`The inspection report ${report.no} is non-compliant (${why}). Final approval stays blocked until a corrected report is uploaded.`);
  }
  const resolved = discrepancyResolved(input.timeline);
  if (input.holdType === 'discrepancy') {
    const rejected = /^\[qty:rejected\]/i.test(String(input.holdReason || ''));
    blocks.push(rejected
      ? 'The quantity discrepancy was rejected. Final approval stays blocked.'
      : 'A quantity discrepancy is pending. Final approval stays blocked until it is resolved.');
  } else if (!resolved && (input.weighed != null || input.certifiedQty != null)) {
    if (!quantitiesMatch(input.declaredQty, input.certifiedQty)) {
      blocks.push(`Quantity discrepancy is unresolved. Declared ${input.declaredQty ?? '—'}, inspected ${input.certifiedQty ?? '—'}.`);
    }
    const certifiedGrade = String(report?.grade || '');
    if (report?.no && !gradesMatch(input.declaredGrade || '', certifiedGrade)) {
      blocks.push(`Certified grade ${certifiedGrade || '—'} does not match declared grade ${input.declaredGrade || '—'}.`);
    }
  }
  return blocks;
}
