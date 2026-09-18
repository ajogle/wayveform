import { describe, expect, it } from 'vitest';
import { parseInventory, previewCsv } from './importers';

describe('inventory import', () => {
  it('preserves quoted CSV values, repeats, and rejected row accounting', () => {
    const csv = '\uFEFFArtist Name,Track Name,Album Name,Duration (ms)\r\n' +
      '"A, B","Song ""One""",Album,180000\r\n' +
      '"A, B","Song ""One""",Album,180000\r\n' +
      ',Untitled,Album,\r\n';
    const result = parseInventory(csv, 'csv', 'batch');
    expect(result.inputCount).toBe(3);
    expect(result.items).toHaveLength(2);
    expect(result.errors).toMatchObject([{ sourceOrder: 3, message: 'Missing artist.' }]);
    expect(result.errors[0].originalValues?.['Track Name']).toBe('Untitled');
    expect(result.duplicateCount).toBe(1);
    expect(result.items.map(item => item.sourceOrder)).toEqual([1, 2]);
    expect(result.items[0].title).toBe('Song "One"');
    expect(result.items[0].originalValues['Artist Name']).toBe('A, B');
  });

  it('accepts nested track JSON while leaving absent metadata unknown', () => {
    const result = parseInventory(JSON.stringify({ items: [
      { track: { name: 'Quiet', artists: [{ name: 'Example' }] } },
    ] }), 'json', 'batch');
    expect(result.items[0]).toMatchObject({ title: 'Quiet', artist: 'Example', album: null, durationMs: null, isrc: null });
  });

  it('rejects malformed JSON with a useful message', () => {
    expect(() => parseInventory('{', 'json')).toThrow('JSON file could not be parsed');
  });

  it('previews unknown headers and uses the selected column mapping', () => {
    const csv = 'Performer,Work,Record\nOne,First,Album A\nTwo,Second,Album B\n';
    const preview = previewCsv(csv);
    expect(preview.headers).toEqual(['Performer', 'Work', 'Record']);
    expect(preview.inputCount).toBe(2);
    expect(preview.suggestedMapping.artist).toBeUndefined();
    const result = parseInventory(csv, 'csv', 'batch', { artist: 'Performer', title: 'Work', album: 'Record' });
    expect(result.items.map(item => item.title)).toEqual(['First', 'Second']);
    expect(result.items[0].album).toBe('Album A');
    expect(() => parseInventory(csv, 'csv', 'batch', { artist: 'Bad', title: 'Work' })).toThrow('not in this CSV');
  });

  it('rejects rows with extra CSV cells instead of silently dropping them', () => {
    expect(() => previewCsv('Artist,Title\nOne,Song,Lost value\n')).toThrow('more values than column names');
  });

  it('accounts for a 1,200-track inventory without losing repeated occurrences', () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ artist: `Artist ${i % 40}`, title: `Song ${i % 300}` }));
    const result = parseInventory(JSON.stringify(rows), 'json', 'batch');
    expect(result.inputCount).toBe(1200);
    expect(result.items.length + result.errors.length).toBe(1200);
    expect(result.items[0].sourceOrder).toBe(1);
    expect(result.items.at(-1)?.sourceOrder).toBe(1200);
    expect(result.duplicateCount).toBeGreaterThan(0);
  });
});
