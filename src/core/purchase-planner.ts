export interface WantedRecording {
  id: string;
  label: string;
  owned: boolean;
  purchased?: boolean;
}

export interface PurchaseOffer {
  id: string;
  candidateId: string;
  provider: string;
  label: string;
  coverage: string[];
  priceMinor: number | null;
  currency: string | null;
  country: string;
  quality: 'lossless' | 'lossy' | 'unknown';
  available: boolean;
  accepted: boolean;
}

export interface PlanPolicy {
  country: string;
  currency: string;
  losslessOnly: boolean;
  storePenaltyMinor: number;
  maxBudgetMinor: number | null;
}

export interface PurchasePlan {
  selected: PurchaseOffer[];
  uncovered: string[];
  unknownCost: string[];
  estimatedSubtotalMinor: number;
  estimatedStorePenaltyMinor: number;
  estimatedTotalMinor: number;
  currency: string;
  wantedCount: number;
  ownedCount: number;
  purchasedAwaitingFileCount: number;
  coveredCount: number;
}

export function planPurchases(recordings: WantedRecording[], offers: PurchaseOffer[], policy: PlanPolicy): PurchasePlan {
  const owned = new Set(recordings.filter(recording => recording.owned).map(recording => recording.id));
  const purchased = new Set(recordings.filter(recording => !recording.owned && recording.purchased).map(recording => recording.id));
  const wanted = new Set(recordings.filter(recording => !recording.owned && !recording.purchased).map(recording => recording.id));
  const eligible = offers.filter(offer => offer.accepted && offer.available && offer.country === policy.country
    && (!policy.losslessOnly || offer.quality === 'lossless'));
  const priced = eligible.filter(offer => offer.currency === policy.currency && offer.priceMinor !== null && offer.priceMinor >= 0);
  const selected: PurchaseOffer[] = [];
  const covered = new Set<string>();
  const stores = new Set<string>();
  let subtotal = 0;

  while (true) {
    let best: PurchaseOffer | null = null;
    let bestRatio = Infinity;
    for (const offer of priced) {
      if (selected.some(chosen => chosen.id === offer.id)) continue;
      const newCoverage = offer.coverage.filter(id => wanted.has(id) && !covered.has(id));
      if (!newCoverage.length) continue;
      const incremental = offer.priceMinor! + (stores.has(offer.provider) ? 0 : policy.storePenaltyMinor);
      const currentTotal = subtotal + offer.priceMinor! + policy.storePenaltyMinor * (stores.size + (stores.has(offer.provider) ? 0 : 1));
      if (policy.maxBudgetMinor !== null && currentTotal > policy.maxBudgetMinor) continue;
      const ratio = incremental / newCoverage.length;
      if (ratio < bestRatio || (ratio === bestRatio && offer.priceMinor! < (best?.priceMinor ?? Infinity))) {
        best = offer;
        bestRatio = ratio;
      }
    }
    if (!best) break;
    selected.push(best);
    subtotal += best.priceMinor!;
    stores.add(best.provider);
    best.coverage.forEach(id => { if (wanted.has(id)) covered.add(id); });
  }

  // Remove offers made redundant by later album or compilation choices.
  function cost(list: PurchaseOffer[]): number {
    return list.reduce((sum, offer) => sum + offer.priceMinor!, 0)
      + new Set(list.map(offer => offer.provider)).size * policy.storePenaltyMinor;
  }
  function reduceRedundant(list: PurchaseOffer[]): PurchaseOffer[] {
    const result = [...list];
    const goal = new Set(result.flatMap(offer => offer.coverage).filter(id => wanted.has(id)));
    while (true) {
      let bestIndex = -1;
      let bestSaving = 0;
      for (let index = 0; index < result.length; index++) {
        const without = result.filter((_, other) => other !== index);
        const remaining = new Set(without.flatMap(offer => offer.coverage));
        const saving = cost(result) - cost(without);
        if (saving > bestSaving && [...goal].every(id => remaining.has(id))) {
          bestIndex = index;
          bestSaving = saving;
        }
      }
      if (bestIndex < 0) break;
      result.splice(bestIndex, 1);
    }
    return result;
  }
  selected.splice(0, selected.length, ...reduceRedundant(selected));
  let improved = true;
  while (improved) {
    improved = false;
    for (const candidate of priced) {
      if (selected.some(offer => offer.id === candidate.id)) continue;
      const replacement = reduceRedundant([...selected, candidate]);
      if (cost(replacement) < cost(selected)
        && (policy.maxBudgetMinor === null || cost(replacement) <= policy.maxBudgetMinor)) {
        selected.splice(0, selected.length, ...replacement);
        improved = true;
        break;
      }
    }
  }

  const finalCovered = new Set(selected.flatMap(offer => offer.coverage).filter(id => wanted.has(id)));
  const unknownCost = [...wanted].filter(id => !finalCovered.has(id) && eligible.some(offer => offer.coverage.includes(id)
    && (offer.priceMinor === null || offer.currency !== policy.currency)));
  const unknownSet = new Set(unknownCost);
  const uncovered = [...wanted].filter(id => !finalCovered.has(id) && !unknownSet.has(id));
  const estimatedSubtotalMinor = selected.reduce((sum, offer) => sum + offer.priceMinor!, 0);
  const estimatedStorePenaltyMinor = new Set(selected.map(offer => offer.provider)).size * policy.storePenaltyMinor;
  return { selected, uncovered, unknownCost, estimatedSubtotalMinor, estimatedStorePenaltyMinor,
    estimatedTotalMinor: estimatedSubtotalMinor + estimatedStorePenaltyMinor,
    currency: policy.currency, wantedCount: wanted.size, ownedCount: owned.size,
    purchasedAwaitingFileCount: purchased.size, coveredCount: finalCovered.size };
}
