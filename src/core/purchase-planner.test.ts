import { describe, expect, it } from 'vitest';
import { planPurchases, type PlanPolicy, type PurchaseOffer } from './purchase-planner';

const policy: PlanPolicy = { country: 'US', currency: 'USD', losslessOnly: false,
  storePenaltyMinor: 0, maxBudgetMinor: null };
const recording = (id: string, owned = false) => ({ id, label: id, owned });
const offer = (id: string, coverage: string[], priceMinor: number | null, provider = 'store'): PurchaseOffer => ({
  id, candidateId: id, provider, label: id, coverage, priceMinor, currency: 'USD', country: 'US',
  quality: 'lossless', available: true, accepted: true,
});

describe('purchase planner', () => {
  it('uses an album when it covers wanted tracks more cheaply than singles', () => {
    const result = planPurchases([recording('a'), recording('b')], [
      offer('single-a', ['a'], 129), offer('single-b', ['b'], 129), offer('album', ['a', 'b'], 199),
    ], policy);
    expect(result.selected.map(x => x.id)).toEqual(['album']);
    expect(result.estimatedTotalMinor).toBe(199);
    expect(result.coveredCount).toBe(2);
  });

  it('never pays for owned recordings or counts repeated occurrences twice', () => {
    const result = planPurchases([recording('a', true), recording('b'), recording('b')], [
      offer('a', ['a'], 129), offer('b', ['b'], 129),
    ], policy);
    expect(result.selected.map(x => x.id)).toEqual(['b']);
    expect(result.ownedCount).toBe(1);
    expect(result.wantedCount).toBe(1);
  });

  it('excludes user-confirmed purchases while waiting for a file', () => {
    const result = planPurchases([{ ...recording('a'), purchased: true }], [offer('a', ['a'], 129)], policy);
    expect(result.selected).toEqual([]);
    expect(result.purchasedAwaitingFileCount).toBe(1);
    expect(result.ownedCount).toBe(0);
  });

  it('keeps unknown cost separate from uncovered, and enforces lossless and budget choices', () => {
    const lossless = planPurchases([recording('a'), recording('b')], [
      offer('a', ['a'], null), { ...offer('b', ['b'], 129), quality: 'unknown' },
    ], { ...policy, losslessOnly: true });
    expect(lossless.unknownCost).toEqual(['a']);
    expect(lossless.uncovered).toEqual(['b']);
    const budget = planPurchases([recording('b')], [offer('b', ['b'], 129)],
      { ...policy, maxBudgetMinor: 100 });
    expect(budget.selected).toEqual([]);
    expect(budget.uncovered).toEqual(['b']);
  });

  it('applies a store penalty once per selected store', () => {
    const result = planPurchases([recording('a'), recording('b')], [
      offer('a', ['a'], 100, 'first'), offer('b', ['b'], 100, 'first'),
      offer('other-b', ['b'], 90, 'other'),
    ], { ...policy, storePenaltyMinor: 50 });
    expect(result.selected.map(x => x.id)).toEqual(['a', 'b']);
    expect(result.estimatedTotalMinor).toBe(250);
  });
});
