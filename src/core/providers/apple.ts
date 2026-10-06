import { randomUUID } from 'node:crypto';
import { normalizeMusicText } from '../file-matcher';
import type { CatalogCandidate, CatalogStatus, SourceItem } from '../../shared/types';

export interface AppleSearchOutcome {
  status: Exclude<CatalogStatus, 'notSearched'>;
  message: string | null;
  candidates: CatalogCandidate[];
  retryAfterMs?: number;
}

export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(Math.ceil(delay), 24 * 60 * 60 * 1000) : null;
}

export function freshCatalogObservation(fetchedAt: string | null, now = Date.now()): boolean {
  if (!fetchedAt) return false;
  const age = now - Date.parse(fetchedAt);
  return Number.isFinite(age) && age >= 0 && age <= 6 * 60 * 60 * 1000;
}

function safeStoreUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['itunes.apple.com', 'music.apple.com'].includes(url.hostname)) return null;
    url.protocol = 'https:';
    return url.toString();
  } catch { return null; }
}

function usdMinor(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Math.abs(value * 100 - cents) < 1e-6 ? cents : null;
}

function matchEvidence(item: SourceItem, candidate: Pick<CatalogCandidate, 'artist' | 'title' | 'album' | 'durationMs'>): Pick<CatalogCandidate, 'matchLevel' | 'reason'> {
  if (normalizeMusicText(item.artist) !== normalizeMusicText(candidate.artist))
    return { matchLevel: 'conflict', reason: 'Primary artist differs.' };
  if (normalizeMusicText(item.title) !== normalizeMusicText(candidate.title))
    return { matchLevel: 'conflict', reason: 'Title or version differs.' };
  if (item.durationMs !== null && candidate.durationMs !== null && Math.abs(item.durationMs - candidate.durationMs) > 10000)
    return { matchLevel: 'conflict', reason: 'Duration differs by more than ten seconds.' };
  if (item.album && candidate.album && normalizeMusicText(item.album) !== normalizeMusicText(candidate.album))
    return { matchLevel: 'review', reason: 'Artist and title agree, but the album differs.' };
  return { matchLevel: 'strong', reason: 'Artist and title agree; review the exact recording and edition.' };
}

export function parseAppleResponse(raw: unknown, item: SourceItem, country = 'US'): CatalogCandidate[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { results?: unknown }).results))
    throw new Error('Apple returned an unexpected response.');
  const results = (raw as { results: unknown[] }).results;
  const candidates: CatalogCandidate[] = [];
  for (const row of results) {
    if (!row || typeof row !== 'object') continue;
    const value = row as Record<string, unknown>;
    if (value.kind !== 'song' || typeof value.trackId !== 'number' || !Number.isSafeInteger(value.trackId)) continue;
    if (typeof value.artistName !== 'string' || typeof value.trackName !== 'string') continue;
    const storeUrl = safeStoreUrl(value.trackViewUrl);
    if (!storeUrl) continue;
    const priceMinor = value.currency === 'USD' ? usdMinor(value.trackPrice) : null;
    const candidate = {
      id: randomUUID(), itemId: item.id, provider: 'apple' as const, providerTrackId: String(value.trackId),
      artist: value.artistName, title: value.trackName,
      album: typeof value.collectionName === 'string' ? value.collectionName : null,
      durationMs: typeof value.trackTimeMillis === 'number' && Number.isFinite(value.trackTimeMillis)
        ? Math.round(value.trackTimeMillis) : null,
      priceMinor, currency: priceMinor === null ? null : 'USD', country, storeUrl, accepted: false,
    };
    candidates.push({ ...candidate, ...matchEvidence(item, candidate) });
  }
  return candidates;
}

export function clearAutoMatch(item: SourceItem, candidates: CatalogCandidate[]): CatalogCandidate | null {
  const matches = candidates.filter(candidate => {
    if (candidate.matchLevel !== 'strong') return false;
    if (normalizeMusicText(candidate.artist) !== normalizeMusicText(item.artist)
      || normalizeMusicText(candidate.title) !== normalizeMusicText(item.title)) return false;
    if (item.album && (!candidate.album
      || normalizeMusicText(candidate.album) !== normalizeMusicText(item.album))) return false;
    return true;
  });
  return matches.length === 1 ? matches[0] : null;
}

export function appleSearchUrl(item: SourceItem, country = 'US'): string {
  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('term', `${item.artist} ${item.title}`);
  url.searchParams.set('country', country);
  url.searchParams.set('media', 'music');
  url.searchParams.set('entity', 'song');
  url.searchParams.set('limit', '25');
  return url.toString();
}

export async function searchApple(item: SourceItem, fetcher: typeof fetch = fetch): Promise<AppleSearchOutcome> {
  let response: Response;
  try {
    response = await fetcher(appleSearchUrl(item), { signal: AbortSignal.timeout(15000),
      headers: { 'Accept': 'application/json', 'User-Agent': 'Wayveform/0.1 (local music inventory)' } });
  } catch {
    return { status: 'providerUnavailable', message: 'Could not reach Apple’s catalog.', candidates: [] };
  }
  if (response.status === 403) return { status: 'accessDenied', message: 'Apple denied catalog access.', candidates: [] };
  if (response.status === 429) return { status: 'rateLimited', message: 'Apple asked us to slow down. Try again later.',
    candidates: [], retryAfterMs: retryAfterMs(response.headers.get('retry-after')) ?? 60000 };
  if (!response.ok) return { status: 'providerUnavailable', message: `Apple catalog returned HTTP ${response.status}.`, candidates: [] };
  try {
    const candidates = parseAppleResponse(await response.json(), item);
    return { status: candidates.length ? 'ready' : 'noCandidates', message: null, candidates };
  } catch {
    return { status: 'providerUnavailable', message: 'Apple returned an unreadable catalog response.', candidates: [] };
  }
}
