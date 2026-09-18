import { mkdtemp, mkdir, rm, lstat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl, { type Entry } from 'yauzl';

const audioExtensions = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.alac', '.wma']);
const maxEntries = 5000;
const maxEntryBytes = 2 * 1024 * 1024 * 1024;
const maxTotalBytes = 5 * 1024 * 1024 * 1024;

function safeParts(entry: Entry): string[] {
  const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
  const parts = entry.fileName.split('/');
  if (entry.fileName.startsWith('/') || entry.fileName.includes('\\') || entry.fileName.includes('\0')
    || unixType === 0o120000 || parts.some(part => part === '.' || part === '..' || part.includes(':')))
    throw new Error('The ZIP contains an unsafe path or symlink.');
  return parts.filter(Boolean);
}

async function safeParent(root: string, parts: string[]): Promise<string> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    await mkdir(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The ZIP contains an unsafe directory.');
  }
  return current;
}

export interface MediaArchiveResult { folder: string; extracted: number; skipped: number }

export async function extractMediaArchive(zipPath: string, destinationRoot: string): Promise<MediaArchiveResult> {
  const info = await lstat(destinationRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Choose a regular destination folder.');
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  if (zip.entryCount > maxEntries) { zip.close(); throw new Error('The ZIP contains too many entries.'); }
  const folder = await mkdtemp(join(destinationRoot, `${basename(zipPath, extname(zipPath))} - Wayveform - `));
  let extracted = 0;
  let skipped = 0;
  let totalBytes = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
      zip.on('error', fail);
      zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          const parts = safeParts(entry);
          const fileName = parts.at(-1);
          if (entry.fileName.endsWith('/') || !fileName || !audioExtensions.has(extname(fileName).toLowerCase())) {
            skipped++;
            zip.readEntry();
            return;
          }
          if (entry.uncompressedSize > maxEntryBytes || entry.compressedSize === 0 && entry.uncompressedSize > 0
            || entry.uncompressedSize > entry.compressedSize * 1000)
            throw new Error('A media file exceeds the ZIP safety limit.');
          totalBytes += entry.uncompressedSize;
          if (totalBytes > maxTotalBytes) throw new Error('The ZIP exceeds the total media size limit.');
          const parent = await safeParent(folder, parts.slice(0, -1));
          const stream = await zip.openReadStreamPromise(entry);
          let written = 0;
          const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            written += chunk.length;
            if (written > maxEntryBytes || written > entry.uncompressedSize)
              callback(new Error('A media file expanded beyond the ZIP safety limit.'));
            else callback(null, chunk);
          } });
          await pipeline(stream, limiter, createWriteStream(join(parent, fileName), { flags: 'wx', mode: 0o600 }));
          if (written !== entry.uncompressedSize) throw new Error('A media file is incomplete.');
          extracted++;
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
    if (!extracted) throw new Error('The ZIP contains no supported audio files.');
    return { folder, extracted, skipped };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  } finally { zip.close(); }
}
