import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { extractMediaArchive } from './media-archive';

const roots: string[] = [];
async function fixture(entries: Record<string, Uint8Array>) {
  const root = await mkdtemp(join(tmpdir(), 'wayveform-media-test-'));
  roots.push(root);
  const zipPath = join(root, 'download.zip');
  await writeFile(zipPath, Buffer.from(zipSync(entries)));
  return { root, zipPath };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('downloaded audio ZIP ingestion', () => {
  it('extracts audio while ignoring unrelated files', async () => {
    const { root, zipPath } = await fixture({
      'Album/track.flac': strToU8('audio bytes'),
      'Album/cover.jpg': strToU8('image bytes'),
    });
    const result = await extractMediaArchive(zipPath, root);
    expect(result.extracted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(await readFile(join(result.folder, 'Album', 'track.flac'), 'utf8')).toBe('audio bytes');
    expect(await readFile(zipPath)).toBeTruthy();
  });

  it('rejects path traversal and cleans up its staging folder', async () => {
    const { root, zipPath } = await fixture({ '../escape.mp3': strToU8('bad') });
    await expect(extractMediaArchive(zipPath, root)).rejects.toThrow(/unsafe path|invalid relative path/);
    expect(await readdir(root)).toEqual(['download.zip']);
  });

  it('rejects excessive compression before writing an audio file', async () => {
    const { root, zipPath } = await fixture({ 'zeros.wav': strToU8('0'.repeat(1000000)) });
    await expect(extractMediaArchive(zipPath, root)).rejects.toThrow(/safety limit/);
    expect(await readdir(root)).toEqual(['download.zip']);
  });
});
