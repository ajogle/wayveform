import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { copyFile, stat, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import type { ColumnMapping } from '../shared/types';
import { replaceDatabaseSnapshot } from '../core/database-recovery';

let worker: Worker | null = null;
let mainWindow: BrowserWindow | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const preparedImports = new Map<string, { filePath: string; inputHash: string }>();
const trace = (...parts: unknown[]) => { if (process.env.WAYVEFORM_DEBUG) console.error('[Wayveform]', ...parts); };

function sendToWorker(message: Record<string, unknown>): Promise<any> {
  if (!worker) return Promise.reject(new Error('The local database worker is unavailable. Restart the app.'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ ...message, id });
  });
}

function validSender(event: Electron.IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return url.startsWith('file://') && event.sender === mainWindow?.webContents;
}

async function createWindow() {
  trace('creating window');
  mkdirSync(app.getPath('userData'), { recursive: true });
  if (!worker) {
    worker = new Worker(join(__dirname, 'worker.js'), {
      workerData: { databasePath: join(app.getPath('userData'), 'inventory.sqlite') },
    });
    worker.on('message', ({ id, result, error, event, progress }) => {
      if (event === 'scanProgress') {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('scan:progress', progress);
        return;
      }
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      if (error) job.reject(new Error(error)); else job.resolve(result);
    });
    worker.on('error', error => {
      trace('worker error', error);
      for (const job of pending.values()) job.reject(error);
      pending.clear();
    });
    worker.on('exit', () => {
      trace('worker exited');
      worker = null;
      for (const job of pending.values()) job.reject(new Error('The local database worker stopped. Restart the app.'));
      pending.clear();
    });
  }

  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 600,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('closed', () => { mainWindow = null; preparedImports.clear(); });
  mainWindow.on('close', () => trace('window closing'));
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => trace('load failed', code, description));
  mainWindow.webContents.on('render-process-gone', (_event, details) => trace('renderer gone', details.reason));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  trace('window loaded');
}

app.whenReady().then(() => {
  ipcMain.handle('inventory:prepare', async event => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    const selection = await dialog.showOpenDialog({ properties: ['openFile'], filters: [
      { name: 'Music inventory', extensions: ['csv', 'json', 'zip'] },
    ] });
    if (selection.canceled || !selection.filePaths.length) return null;
    const filePath = selection.filePaths[0];
    const extension = extname(filePath).toLowerCase();
    if (!['.csv', '.json', '.zip'].includes(extension)) throw new Error('Choose a CSV, JSON, or ZIP inventory.');
    const maximumSize = extension === '.zip' ? 200 : 30;
    if ((await stat(filePath)).size > maximumSize * 1024 * 1024) throw new Error(`Choose an inventory smaller than ${maximumSize} MB.`);
    if (extension === '.json' || extension === '.zip') {
      const result = await sendToWorker({ type: 'import', filePath });
      return { kind: 'imported', ...result };
    }
    const preview = await sendToWorker({ type: 'preview', filePath });
    const token = randomUUID();
    preparedImports.clear();
    preparedImports.set(token, { filePath, inputHash: preview.inputHash });
    return { kind: 'csvPreview', token, fileName: basename(filePath), ...preview };
  });
  ipcMain.handle('inventory:commit', async (event, token: string, mapping: ColumnMapping) => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    const prepared = preparedImports.get(token);
    if (!prepared) throw new Error('Choose the inventory file again.');
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Invalid column mapping.');
    if ((await stat(prepared.filePath)).size > 30 * 1024 * 1024) throw new Error('Choose an inventory smaller than 30 MB.');
    const result = await sendToWorker({ type: 'import', filePath: prepared.filePath, mapping, expectedHash: prepared.inputHash });
    preparedImports.delete(token);
    return result;
  });
  ipcMain.handle('inventory:list', (event, offset: number, limit: number, batchId?: string | null, collection?: string | null) => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const safeLimit = Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 100;
    return sendToWorker({ type: 'inventory', offset: safeOffset, limit: safeLimit,
      batchId: typeof batchId === 'string' ? batchId : null,
      collection: typeof collection === 'string' ? collection.slice(0, 300) : null });
  });
  ipcMain.handle('inventory:errors', (event, batchId: string) => {
    if (!validSender(event) || typeof batchId !== 'string') throw new Error('Invalid request.');
    return sendToWorker({ type: 'errors', batchId });
  });
  ipcMain.handle('inventory:delete', async (event, batchId: string) => {
    if (!validSender(event) || typeof batchId !== 'string') throw new Error('Invalid request.');
    const response = await dialog.showMessageBox(mainWindow!, {
      type: 'warning', buttons: ['Cancel', 'Delete import'], defaultId: 0, cancelId: 0,
      message: 'Delete this imported music list?',
      detail: 'Its tracks, catalog decisions, and purchase confirmations will be removed from the local database. Audio files and saved backups stay in place.',
    });
    if (response.response !== 1) return false;
    await sendToWorker({ type: 'deleteBatch', batchId });
    return true;
  });
  ipcMain.handle('inventory:export', async (event, format: 'csv' | 'json', batchId?: string | null) => {
    if (!validSender(event) || (format !== 'csv' && format !== 'json')) throw new Error('Invalid export request.');
    const selection = await dialog.showSaveDialog({
      defaultPath: `wayveform-inventory.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    return sendToWorker({ type: 'export', filePath: selection.filePath, format, batchId: typeof batchId === 'string' ? batchId : null });
  });
  ipcMain.handle('database:backup', async event => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    const selection = await dialog.showSaveDialog({
      defaultPath: `Wayveform-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
      filters: [{ name: 'Wayveform database', extensions: ['sqlite'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    if (selection.filePath === join(app.getPath('userData'), 'inventory.sqlite'))
      throw new Error('Choose a backup filename outside the active database.');
    try {
      await stat(selection.filePath);
      throw new Error('A file with that name already exists. Choose a new backup filename.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return sendToWorker({ type: 'backup', filePath: selection.filePath });
  });
  ipcMain.handle('database:restore', async event => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    const selection = await dialog.showOpenDialog({ properties: ['openFile'],
      filters: [{ name: 'Wayveform database', extensions: ['sqlite'] }] });
    if (selection.canceled || !selection.filePaths.length) return;
    const source = selection.filePaths[0];
    const databasePath = join(app.getPath('userData'), 'inventory.sqlite');
    if (source === databasePath) throw new Error('Choose a backup file, not the active database.');
    if ((await stat(source)).size > 2 * 1024 * 1024 * 1024) throw new Error('Choose a backup smaller than 2 GB.');
    const staged = `${databasePath}.restore-${randomUUID()}.tmp`;
    let workerStopped = false;
    try {
      await copyFile(source, staged, fsConstants.COPYFILE_EXCL);
      const details = await sendToWorker({ type: 'validateBackup', filePath: staged }) as { batches: number; tracks: number };
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'warning', buttons: ['Cancel', 'Restore backup'], defaultId: 0, cancelId: 0,
        title: 'Restore Wayveform backup',
        message: `Restore ${details.tracks} tracks from ${details.batches} imports?`,
        detail: 'The current database will be saved beside it before replacement. Wayveform will restart. Music files will not be deleted.',
      });
      if (confirmation.response !== 1) return;
      await sendToWorker({ type: 'discoveryPause' });
      await sendToWorker({ type: 'scanCancel' });
      const safetyPath = `${databasePath}.before-restore-${Date.now()}-${randomUUID()}.sqlite`;
      await sendToWorker({ type: 'backup', filePath: safetyPath });
      await worker!.terminate();
      workerStopped = true;
      await replaceDatabaseSnapshot(databasePath, staged);
      await dialog.showMessageBox(mainWindow!, { type: 'info', message: 'Backup restored. Wayveform will restart.',
        detail: `The previous database was saved at ${safetyPath}.` });
      app.relaunch();
      app.quit();
    } catch (error) {
      if (workerStopped) { app.relaunch(); app.quit(); }
      throw error;
    } finally { await unlink(staged).catch(() => undefined); }
  });
  ipcMain.handle('files:scan', async event => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    const selection = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (selection.canceled || !selection.filePaths.length) return null;
    return sendToWorker({ type: 'scan', folder: selection.filePaths[0] });
  });
  ipcMain.handle('files:scanCancel', event => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    return sendToWorker({ type: 'scanCancel' });
  });
  ipcMain.handle('files:importZip', async event => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    const archive = await dialog.showOpenDialog({ properties: ['openFile'],
      filters: [{ name: 'Downloaded audio ZIP', extensions: ['zip'] }] });
    if (archive.canceled || !archive.filePaths.length) return null;
    const filePath = archive.filePaths[0];
    if (extname(filePath).toLowerCase() !== '.zip' || (await stat(filePath)).size > 5 * 1024 * 1024 * 1024)
      throw new Error('Choose an audio ZIP smaller than 5 GB.');
    const destination = await dialog.showOpenDialog({ properties: ['openDirectory'],
      title: 'Choose where to keep the extracted audio files' });
    if (destination.canceled || !destination.filePaths.length) return null;
    return sendToWorker({ type: 'mediaZip', filePath, folder: destination.filePaths[0] });
  });
  ipcMain.handle('files:list', (event, offset: number, limit: number) => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const safeLimit = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 30;
    return sendToWorker({ type: 'files', offset: safeOffset, limit: safeLimit });
  });
  ipcMain.handle('files:confirm', (event, fileId: string, itemId: string) => {
    if (!validSender(event) || typeof fileId !== 'string' || typeof itemId !== 'string') throw new Error('Invalid request.');
    return sendToWorker({ type: 'confirmFile', fileId, itemId });
  });
  ipcMain.handle('files:confirmManual', (event, fileId: string, itemId: string) => {
    if (!validSender(event) || typeof fileId !== 'string' || typeof itemId !== 'string') throw new Error('Invalid request.');
    return sendToWorker({ type: 'confirmManualFile', fileId, itemId });
  });
  ipcMain.handle('inventory:search', (event, query: string) => {
    if (!validSender(event) || typeof query !== 'string') throw new Error('Invalid request.');
    return sendToWorker({ type: 'inventorySearch', query: query.slice(0, 80) });
  });
  ipcMain.handle('files:remove', (event, itemId: string) => {
    if (!validSender(event) || typeof itemId !== 'string') throw new Error('Invalid request.');
    return sendToWorker({ type: 'removeFile', itemId });
  });
  ipcMain.handle('files:organize', async event => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    const selection = await dialog.showOpenDialog({ properties: ['openDirectory'],
      title: 'Choose a destination for copies of linked files' });
    if (selection.canceled || !selection.filePaths.length) return null;
    return sendToWorker({ type: 'organize', folder: selection.filePaths[0] });
  });
  ipcMain.handle('files:undoCopy', (event, copyId: string) => {
    if (!validSender(event) || typeof copyId !== 'string') throw new Error('Invalid request.');
    return sendToWorker({ type: 'undoCopy', copyId });
  });
  ipcMain.handle('playlist:export', async (event, batchId?: string | null, collection?: string | null) => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    const selection = await dialog.showSaveDialog({
      defaultPath: 'wayveform-playlist.m3u8',
      filters: [{ name: 'M3U8 playlist', extensions: ['m3u8'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    return sendToWorker({ type: 'playlist', filePath: selection.filePath,
      batchId: typeof batchId === 'string' ? batchId : null,
      collection: typeof collection === 'string' ? collection.slice(0, 300) : null });
  });
  ipcMain.handle('catalog:search', (event, itemId: string) => {
    if (!validSender(event) || typeof itemId !== 'string') throw new Error('Invalid request.');
    return sendToWorker({ type: 'catalogSearch', itemId });
  });
  ipcMain.handle('catalog:get', (event, itemId: string) => {
    if (!validSender(event) || typeof itemId !== 'string') throw new Error('Invalid request.');
    return sendToWorker({ type: 'catalogGet', itemId });
  });
  ipcMain.handle('catalog:accept', (event, itemId: string, candidateId: string) => {
    if (!validSender(event) || typeof itemId !== 'string' || typeof candidateId !== 'string') throw new Error('Invalid request.');
    return sendToWorker({ type: 'catalogAccept', itemId, candidateId });
  });
  ipcMain.handle('catalog:openStore', async (event, candidateId: string) => {
    if (!validSender(event) || typeof candidateId !== 'string') throw new Error('Invalid request.');
    const value = await sendToWorker({ type: 'catalogUrl', candidateId }) as string;
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['itunes.apple.com', 'music.apple.com'].includes(url.hostname))
      throw new Error('Store link is not allowed.');
    await shell.openExternal(url.toString());
    await sendToWorker({ type: 'catalogOpened', candidateId });
  });
  ipcMain.handle('purchase:confirm', (event, candidateId: string) => {
    if (!validSender(event) || typeof candidateId !== 'string') throw new Error('Invalid request.');
    return sendToWorker({ type: 'purchaseConfirm', candidateId });
  });
  ipcMain.handle('purchase:undo', (event, candidateId: string) => {
    if (!validSender(event) || typeof candidateId !== 'string') throw new Error('Invalid request.');
    return sendToWorker({ type: 'purchaseUndo', candidateId });
  });
  ipcMain.handle('discovery:start', (event, batchId?: string | null) => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    return sendToWorker({ type: 'discoveryStart', batchId: typeof batchId === 'string' ? batchId : null });
  });
  ipcMain.handle('discovery:pause', event => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    return sendToWorker({ type: 'discoveryPause' });
  });
  ipcMain.handle('discovery:progress', event => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    return sendToWorker({ type: 'discoveryProgress' });
  });
  ipcMain.handle('purchase:plan', (event, batchId?: string | null, losslessOnly?: boolean,
    storePenaltyMinor?: number, maxBudgetMinor?: number | null) => {
    if (!validSender(event)) throw new Error('Invalid sender.');
    const safePenalty = Number.isSafeInteger(storePenaltyMinor) && (storePenaltyMinor ?? 0) >= 0
      ? Math.min(storePenaltyMinor!, 100000) : 0;
    const safeBudget = maxBudgetMinor === null || maxBudgetMinor === undefined ? null
      : Number.isSafeInteger(maxBudgetMinor) && maxBudgetMinor >= 0 ? maxBudgetMinor : null;
    return sendToWorker({ type: 'purchasePlan', batchId: typeof batchId === 'string' ? batchId : null,
      losslessOnly: losslessOnly === true, storePenaltyMinor: safePenalty, maxBudgetMinor: safeBudget });
  });
  createWindow();
});

app.on('window-all-closed', () => {
  trace('all windows closed');
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { trace('before quit'); void worker?.terminate(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
