import type { FileAsset, FileSuggestion, SourceItem } from '../shared/types';

export function normalizeMusicText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export function sameSourceRecording(a: SourceItem, b: SourceItem): boolean {
  return normalizeMusicText(a.artist) === normalizeMusicText(b.artist)
    && normalizeMusicText(a.title) === normalizeMusicText(b.title)
    && normalizeMusicText(a.album) === normalizeMusicText(b.album)
    && normalizeMusicText(a.isrc) === normalizeMusicText(b.isrc);
}

export function sourceRecordingKey(item: SourceItem): string {
  return [item.artist, item.title, item.album, item.isrc].map(normalizeMusicText).join('\0');
}

export function suggestFiles(file: Pick<FileAsset, 'artist' | 'title' | 'album' | 'durationMs'>, items: SourceItem[]): FileSuggestion[] {
  const artist = normalizeMusicText(file.artist);
  const title = normalizeMusicText(file.title);
  if (!artist || !title) return [];
  return items.filter(item => {
    if (normalizeMusicText(item.artist) !== artist || normalizeMusicText(item.title) !== title) return false;
    if (file.durationMs !== null && item.durationMs !== null && Math.abs(file.durationMs - item.durationMs) > 5000) return false;
    return true;
  }).slice(0, 8).map(item => ({
    itemId: item.id, artist: item.artist, title: item.title, album: item.album,
    reason: file.album && item.album && normalizeMusicText(file.album) === normalizeMusicText(item.album)
      ? 'Artist, title, and album agree; review the recording before linking.'
      : 'Artist and title agree; confirm the version and album.',
  }));
}
