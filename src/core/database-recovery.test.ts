import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { replaceDatabaseSnapshot } from './database-recovery';

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'wayveform-restore-test-'));
  roots.push(root);
  const database = join(root, 'inventory.sqlite');
  const staged = join(root, 'staged.sqlite');
  await writeFile(database, 'old');
  await writeFile(`${database}-wal`, 'old wal');
  await writeFile(`${database}-shm`, 'old shm');
  return { database, staged };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('database restore file replacement', () => {
  it('installs a snapshot and clears old SQLite sidecars', async () => {
    const { database, staged } = await setup();
    await writeFile(staged, 'restored');
    await replaceDatabaseSnapshot(database, staged);
    expect(await readFile(database, 'utf8')).toBe('restored');
    await expect(readFile(`${database}-wal`)).rejects.toThrow();
    await expect(readFile(`${database}-shm`)).rejects.toThrow();
  });

  it('rolls back the database and sidecars if the staged snapshot disappears', async () => {
    const { database, staged } = await setup();
    await expect(replaceDatabaseSnapshot(database, staged)).rejects.toThrow();
    expect(await readFile(database, 'utf8')).toBe('old');
    expect(await readFile(`${database}-wal`, 'utf8')).toBe('old wal');
    expect(await readFile(`${database}-shm`, 'utf8')).toBe('old shm');
  });
});
