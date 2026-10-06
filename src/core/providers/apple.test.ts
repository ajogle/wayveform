import { describe, expect, it } from 'vitest';
import { appleSearchUrl, clearAutoMatch, freshCatalogObservation, parseAppleResponse, retryAfterMs, searchApple } from './apple';
import type { SourceItem } from '../../shared/types';

const item: SourceItem = { id: 'item', batchId: 'batch', sourceOrder: 1,
  artist: 'Example', title: 'Song', album: 'Album', durationMs: 180000,
  isrc: null, sourceCollection: null, originalValues: {} };

const result = { kind: 'song', trackId: 123, artistName: 'Example', trackName: 'Song',
  collectionName: 'Album', trackTimeMillis: 180500, trackPrice: 1.29,
  currency: 'USD', trackViewUrl: 'http://itunes.apple.com/us/album/example/123' };

describe('Apple catalog adapter', () => {
  it('constructs a country-specific song search', () => {
    const url = new URL(appleSearchUrl(item));
    expect(url.hostname).toBe('itunes.apple.com');
    expect(url.searchParams.get('country')).toBe('US');
    expect(url.searchParams.get('entity')).toBe('song');
  });

  it('parses a price exactly and keeps version conflicts visible', () => {
    const candidates = parseAppleResponse({ results: [result, { ...result, trackId: 124, trackName: 'Song (Live)' }] }, item);
    expect(candidates[0]).toMatchObject({ priceMinor: 129, currency: 'USD', matchLevel: 'strong' });
    expect(candidates[0].storeUrl.startsWith('https://')).toBe(true);
    expect(candidates[1].matchLevel).toBe('conflict');
  });

  it('discards unsafe store links and does not invent unavailable prices', () => {
    const candidates = parseAppleResponse({ results: [
      { ...result, trackId: 1, trackViewUrl: 'https://evil.example/buy' },
      { ...result, trackId: 2, trackPrice: undefined },
    ] }, item);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].priceMinor).toBeNull();
  });

  it('auto-selects only one unambiguous strong album match', () => {
    const candidates = parseAppleResponse({ results: [result] }, item);
    expect(clearAutoMatch(item, candidates)?.providerTrackId).toBe('123');
    expect(clearAutoMatch(item, [...candidates, { ...candidates[0], id: 'second', providerTrackId: '456' }])).toBeNull();
    expect(clearAutoMatch(item, [{ ...candidates[0], album: null }])).toBeNull();
    expect(clearAutoMatch(item, [{ ...candidates[0], matchLevel: 'review' }])).toBeNull();
  });

  it('distinguishes no results from provider failures', async () => {
    const noResults = await searchApple(item, async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const limited = await searchApple(item, async () => new Response('', { status: 429 }));
    expect(noResults.status).toBe('noCandidates');
    expect(limited.status).toBe('rateLimited');
  });

  it('honors bounded Retry-After delays from the provider', async () => {
    expect(retryAfterMs('12')).toBe(12000);
    expect(retryAfterMs('Wed, 16 Sep 2026 20:01:00 GMT', Date.parse('2026-09-16T20:00:00Z'))).toBe(60000);
    expect(retryAfterMs('not a date')).toBeNull();
    const limited = await searchApple(item, async () => new Response('',
      { status: 429, headers: { 'Retry-After': '17' } }));
    expect(limited.retryAfterMs).toBe(17000);
  });

  it('requires a recent catalog observation before store handoff', () => {
    const now = Date.parse('2026-09-16T20:00:00Z');
    expect(freshCatalogObservation('2026-09-16T19:00:00Z', now)).toBe(true);
    expect(freshCatalogObservation('2026-09-16T13:00:00Z', now)).toBe(false);
    expect(freshCatalogObservation('invalid', now)).toBe(false);
  });
});
