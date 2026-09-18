import path from 'node:path';

export interface PlaylistEntry {
  artist: string;
  title: string;
  durationMs: number | null;
  filePath: string | null;
  unavailable?: boolean;
}

export function makeM3u8(entries: PlaylistEntry[], playlistPath: string,
  pathApi: Pick<typeof path, 'relative' | 'dirname' | 'isAbsolute' | 'sep'> = path): { text: string; included: number; unresolved: number; unavailable: number } {
  const lines = ['#EXTM3U'];
  let included = 0;
  let unresolved = 0;
  let unavailable = 0;
  for (const entry of entries) {
    if (!entry.filePath) {
      if (entry.unavailable) unavailable++; else unresolved++;
      continue;
    }
    let relative = pathApi.relative(pathApi.dirname(playlistPath), entry.filePath);
    if (!relative || pathApi.isAbsolute(relative) || /[\r\n]/.test(relative)) { unavailable++; continue; }
    relative = relative.split(pathApi.sep).join('/');
    if (relative.startsWith('#')) relative = `./${relative}`;
    const label = `${entry.artist} - ${entry.title}`.replace(/[\r\n]/g, ' ');
    lines.push(`#EXTINF:${entry.durationMs === null ? -1 : Math.round(entry.durationMs / 1000)},${label}`);
    lines.push(relative);
    included++;
  }
  return { text: lines.join('\n') + '\n', included, unresolved, unavailable };
}
