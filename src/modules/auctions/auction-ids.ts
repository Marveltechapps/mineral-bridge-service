/**
 * Normalize user/org ids for auction winner checks (BUG-018).
 * Mongo may store ObjectId; JWT/auth exposes string — compare as trimmed strings.
 */
export function sameActorId(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  const left = String(typeof a === 'object' && a !== null && 'toString' in a ? (a as { toString(): string }).toString() : a).trim();
  const right = String(typeof b === 'object' && b !== null && 'toString' in b ? (b as { toString(): string }).toString() : b).trim();
  if (!left || !right || left === 'undefined' || right === 'undefined' || left === 'null' || right === 'null') {
    return false;
  }
  return left === right;
}
