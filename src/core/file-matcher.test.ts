import { describe, expect, it } from 'vitest';
import { normalizeMusicText, sameSourceRecording, suggestFiles } from './file-matcher';
import type { FileAsset, SourceItem } from '../shared/types';

function item(id: string, title: string, album = 'Album', durationMs: number | null = 180000): SourceItem {
  return { id, batchId: 'batch', sourceOrder: 1, artist: 'Example', title, album,
    durationMs, isrc: null, sourceCollection: null, originalValues: {} };
}

const file: Pick<FileAsset, 'artist' | 'title' | 'album' | 'durationMs'> = {
  artist: 'Example', title: 'Song', album: 'Album', durationMs: 180500,
};

describe('local file suggestions', () => {
  it('normalizes punctuation but preserves meaningful version words', () => {
    expect(normalizeMusicText('Ｓｏｎｇ (Live)')).toBe('song live');
    expect(suggestFiles(file, [item('studio', 'Song'), item('live', 'Song (Live)')]).map(x => x.itemId)).toEqual(['studio']);
  });

  it('rejects incompatible durations and keeps close matches for review', () => {
    expect(suggestFiles(file, [item('wrong', 'Song', 'Album', 210000)])).toEqual([]);
    expect(suggestFiles(file, [item('close', 'Song')])[0].reason).toContain('review');
  });

  it('recognizes repeated occurrences without treating different albums as identical', () => {
    expect(sameSourceRecording(item('a', 'Song'), item('b', 'Song'))).toBe(true);
    expect(sameSourceRecording(item('a', 'Song'), item('c', 'Song', 'Live Album'))).toBe(false);
  });
});
