import { describe, expect, it } from 'vitest';
import { spotifyRowsFromJson } from './spotify-export';
import { parseInventory } from './importers';

describe('Spotify account-data conversion', () => {
  it('keeps saved library songs and their URI as original data', () => {
    const rows = spotifyRowsFromJson('YourLibrary.json', { tracks: [
      { artist: 'A', track: 'One', album: 'Record', uri: 'spotify:track:123' },
    ] });
    const parsed = parseInventory(JSON.stringify(rows), 'json');
    expect(parsed.items[0]).toMatchObject({ artist: 'A', title: 'One', album: 'Record', sourceCollection: 'Liked Songs' });
    expect(parsed.items[0].originalValues.uri).toBe('spotify:track:123');
  });

  it('preserves playlist order and repeated songs', () => {
    const rows = spotifyRowsFromJson('Playlist1.json', { playlists: [{ name: 'Favorites', items: [
      { track: { artistName: 'A', trackName: 'One', albumName: 'Record' } },
      { track: { artistName: 'A', trackName: 'One', albumName: 'Record' } },
    ] }] });
    const parsed = parseInventory(JSON.stringify(rows), 'json');
    expect(parsed.items.map(item => item.sourceOrder)).toEqual([1, 2]);
    expect(parsed.items.map(item => item.sourceCollection)).toEqual(['Favorites', 'Favorites']);
    expect(parsed.duplicateCount).toBe(1);
  });

  it('decodes Spotify local-track URIs', () => {
    const rows = spotifyRowsFromJson('Playlist1.json', { playlists: [{ name: 'Local files', items: [
      { localTrack: { uri: 'spotify:local:Bj%C3%B6rk:Debut:Human%20Behaviour:252' } },
    ] }] });
    const parsed = parseInventory(JSON.stringify(rows), 'json');
    expect(parsed.items[0]).toMatchObject({
      artist: 'Björk', title: 'Human Behaviour', album: 'Debut', durationMs: 252000,
      sourceCollection: 'Local files',
    });
    expect(parsed.items[0].originalValues.localTrack).toEqual({
      uri: 'spotify:local:Bj%C3%B6rk:Debut:Human%20Behaviour:252',
    });
  });

  it('leaves malformed and incomplete local tracks for normal row validation', () => {
    const rows = spotifyRowsFromJson('Playlist1.json', { playlists: [{ name: 'Local files', items: [
      { localTrack: { uri: 'spotify:local::Album:Untitled:120' } },
      { localTrack: { uri: 'spotify:local:bad%ZZ:Album:Title:120' } },
    ] }] });
    const parsed = parseInventory(JSON.stringify(rows), 'json');
    expect(parsed.items).toHaveLength(0);
    expect(parsed.errors.map(error => error.message)).toEqual(['Missing artist.', 'Missing artist.']);
  });

  it('rejects an unexpected relevant file schema', () => {
    expect(() => spotifyRowsFromJson('Playlist1.json', { payments: [] })).toThrow('no playlists array');
  });
});
