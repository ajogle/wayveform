import { rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function removeIfPresent(path: string): Promise<void> {
  await unlink(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

async function moveIfPresent(from: string, to: string): Promise<boolean> {
  try { await rename(from, to); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Replace a closed SQLite database with a validated standalone snapshot. */
export async function replaceDatabaseSnapshot(databasePath: string, stagedSnapshotPath: string): Promise<void> {
  const displaced = `${databasePath}.replaced-${randomUUID()}`;
  await rename(databasePath, displaced);
  let movedWal = false;
  let movedShm = false;
  try {
    movedWal = await moveIfPresent(`${databasePath}-wal`, `${displaced}-wal`);
    movedShm = await moveIfPresent(`${databasePath}-shm`, `${displaced}-shm`);
    await rename(stagedSnapshotPath, databasePath);
  } catch (error) {
    if (movedShm) await rename(`${displaced}-shm`, `${databasePath}-shm`);
    if (movedWal) await rename(`${displaced}-wal`, `${databasePath}-wal`);
    await rename(displaced, databasePath);
    throw error;
  }
  await Promise.all([displaced, `${displaced}-wal`, `${displaced}-shm`].map(path => removeIfPresent(path).catch(() => undefined)));
}
