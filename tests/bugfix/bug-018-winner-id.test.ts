/**
 * BUG-018: winner id comparison must accept str / ObjectId.
 * @tags bugfix auction
 */
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { sameActorId } from '../../src/modules/auctions/auction-ids.js';

describe('bugfix auction winner id (BUG-018)', () => {
  it('bug_018 unit: str / ObjectId / None', () => {
    const id = new Types.ObjectId();
    expect(sameActorId(id, id.toString())).toBe(true);
    expect(sameActorId(id.toString(), id)).toBe(true);
    expect(sameActorId(id.toString(), id.toString())).toBe(true);
    expect(sameActorId(id, new Types.ObjectId())).toBe(false);
    expect(sameActorId(null, id)).toBe(false);
    expect(sameActorId(id, undefined)).toBe(false);
    expect(sameActorId('', id)).toBe(false);
  });

  it('bug_018 neighbouring: whitespace trimmed', () => {
    expect(sameActorId('  abc  ', 'abc')).toBe(true);
  });
});
