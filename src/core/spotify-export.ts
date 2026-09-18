import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import yauzl, { type Entry } from 'yauzl';

type Row = Record<string, unknown>;
const maxEntries = 2000;
const maxEntryBytes = 10 * 1024 * 1024;
const maxTotalBytes = 50 * 1024 * 1024;

export function spotifyRowsFromJson(fileName: string, root: unknown): Row[] {
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error(`${fileName} has an unexpected structure.`);
  const data = root as Row;
  if (/^yourlibrary\.json$/i.test(basename(fileName))) {
    if (!Array.isArray(data.tracks)) throw new Error(`${fileName} has no tracks array.`);
    return data.tracks.map(value => {
      const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
      return { ...row, title: row.track ?? row.trackName, artist: row.artist ?? row.artistName,
        album: row.album ?? row.albumName, collection: 'Liked Songs' };
    });
  }
  if (!Array.isArray(data.playlists)) throw new Error(`${fileName} has no playlists array.`);
  const rows: Row[] = [];
  for (const value of data.playlists) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const playlist = value as Row;
    if (!Array.isArray(playlist.items)) throw new Error(`${fileName} contains a playlist without items.`);
    const collection = typeof playlist.name === 'string' ? playlist.name : 'Unnamed playlist';
    for (const item of playlist.items) {
      const row = item && typeof item === 'object' && !Array.isArray(item) ? item as Row : {};
      const track = row.track && typeof row.track === 'object' && !Array.isArray(row.track) ? row.track as Row : {};
      rows.push({ ...row, ...track, collection });
    }
  }
  return rows;
}

function selectedEntry(entry: Entry): boolean {
  const name = basename(entry.fileName);
  return /^yourlibrary\.json$/i.test(name) || /^playlist[^/]*\.json$/i.test(name);
}

function safeEntry(entry: Entry): boolean {
  const segments = entry.fileName.replaceAll('\\', '/').split('/');
  const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
  return !entry.fileName.startsWith('/') && !segments.includes('..') && !segments.includes('.')
    && unixType !== 0o120000 && !entry.fileName.includes('\0');
}

async function archiveHash(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function readEntry(zip: yauzl.ZipFile, entry: Entry): Promise<string> {
  if (entry.uncompressedSize > maxEntryBytes || entry.compressedSize === 0 && entry.uncompressedSize > 0
    || entry.uncompressedSize > entry.compressedSize * 100)
    throw new Error(`${basename(entry.fileName)} exceeds the archive safety limit.`);
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxEntryBytes) { stream.destroy(); throw new Error('An archive entry expanded beyond the safety limit.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readSpotifyArchive(filePath: string): Promise<{ rows: Row[]; inputHash: string; fileCount: number }> {
  const zip = await yauzl.openPromise(filePath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  if (zip.entryCount > maxEntries) { zip.close(); throw new Error('The ZIP contains too many entries.'); }
  const rows: Row[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zip.on('error', fail);
      zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          if (!safeEntry(entry)) throw new Error('The ZIP contains an unsafe path or symlink.');
          if (!selectedEntry(entry) || entry.fileName.endsWith('/')) { zip.readEntry(); return; }
          totalBytes += entry.uncompressedSize;
          if (totalBytes > maxTotalBytes) throw new Error('Relevant ZIP files exceed the archive safety limit.');
          const content = await readEntry(zip, entry);
          let root: unknown;
          try { root = JSON.parse(content.replace(/^\uFEFF/, '')); }
          catch { throw new Error(`${basename(entry.fileName)} is not valid JSON.`); }
          rows.push(...spotifyRowsFromJson(entry.fileName, root));
          fileCount++;
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  if (!fileCount) throw new Error('No supported YourLibrary or Playlist JSON files were found in the ZIP.');
  return { rows, inputHash: await archiveHash(filePath), fileCount };
}
