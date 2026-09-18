const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { zipSync, strToU8 } = require('fflate');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayveform-smoke-'));
const source = path.join(dir, 'songs.csv');
const exportPath = path.join(dir, 'inventory.json');
const playlistPath = path.join(dir, 'playlist.m3u8');
const musicFolder = path.join(dir, 'music');
fs.mkdirSync(musicFolder);
const csvContent = 'Performer,Work,Record\nExample,One,Album\nExample,One,Album\n,Untitled,Album\n';
fs.writeFileSync(source, csvContent);

function riffChunk(name, data) {
  const header = Buffer.alloc(8);
  header.write(name, 0, 4, 'ascii');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function info(name, value) { return riffChunk(name, Buffer.from(value + '\0', 'utf8')); }
const fmt = Buffer.alloc(16);
fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(8000, 4);
fmt.writeUInt32LE(16000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
const chunks = Buffer.concat([
  riffChunk('fmt ', fmt),
  riffChunk('LIST', Buffer.concat([Buffer.from('INFO'), info('IART', 'Example'), info('INAM', 'One'), info('IPRD', 'Album')])),
  riffChunk('data', Buffer.alloc(16000)),
]);
const wav = Buffer.alloc(12);
wav.write('RIFF', 0, 4, 'ascii'); wav.writeUInt32LE(chunks.length + 4, 4); wav.write('WAVE', 8, 4, 'ascii');
fs.writeFileSync(path.join(musicFolder, 'one.wav'), Buffer.concat([wav, chunks]));
let worker = new Worker(path.resolve('dist/electron/worker.js'), {
  workerData: { databasePath: path.join(dir, 'inventory.sqlite') },
});
let nextId = 1;

function call(type, details = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    function onMessage(message) {
      if (message.id !== id) return;
      worker.off('message', onMessage);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    }
    worker.on('message', onMessage);
    worker.postMessage({ id, type, ...details });
  });
}

(async () => {
  const preview = await call('preview', { filePath: source });
  assert.equal(preview.inputCount, 3);
  assert.deepEqual(preview.headers, ['Performer', 'Work', 'Record']);
  fs.writeFileSync(source, csvContent + 'Changed,File,Now\n');
  await assert.rejects(call('import', { filePath: source, expectedHash: preview.inputHash,
    mapping: { artist: 'Performer', title: 'Work' } }), /changed after preview/);
  fs.writeFileSync(source, csvContent);
  const imported = await call('import', { filePath: source,
    expectedHash: preview.inputHash, mapping: { artist: 'Performer', title: 'Work', album: 'Record' } });
  assert.equal(imported.batch.acceptedCount, 2);
  assert.equal(imported.batch.rejectedCount, 1);
  assert.equal(imported.batch.duplicateCount, 1);
  const inventory = await call('inventory', { offset: 0, limit: 10, batchId: imported.batch.id });
  assert.equal(inventory.totalItems, 2);
  assert.deepEqual(inventory.items.map(item => item.sourceOrder), [1, 2]);
  const errors = await call('errors', { batchId: imported.batch.id });
  assert.equal(errors[0].originalValues.Work, 'Untitled');
  await call('export', { filePath: exportPath, format: 'json', batchId: imported.batch.id });
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.items.length, 2);
  assert.equal(exported.errors.length, 1);
  const scanned = await call('scan', { folder: musicFolder });
  assert.equal(scanned.scanned, 1);
  const files = await call('files', { offset: 0, limit: 10 });
  assert.equal(files.totalFiles, 1);
  assert.equal(files.files[0].suggestions.length, 2);
  const linked = await call('confirmFile', { fileId: files.files[0].id, itemId: inventory.items[0].id });
  assert.equal(linked, 2);
  const library = path.join(dir, 'library');
  fs.mkdirSync(path.join(library, 'Example', 'Album'), { recursive: true });
  const collision = path.join(library, 'Example', 'Album', 'One.wav');
  fs.writeFileSync(collision, 'keep this existing file');
  const organized = await call('organize', { folder: library });
  assert.equal(organized.copied, 1);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'keep this existing file');
  assert.ok(fs.existsSync(path.join(library, 'Example', 'Album', 'One (2).wav')));
  assert.equal((await call('organize', { folder: library })).skipped, 1);
  assert.ok(fs.existsSync(path.join(musicFolder, 'one.wav')));
  const playlist = await call('playlist', { filePath: playlistPath, batchId: imported.batch.id });
  assert.equal(playlist.included, 2);
  assert.match(fs.readFileSync(playlistPath, 'utf8'), /library\/Example\/Album\/One \(2\).wav/);
  const copiedFile = (await call('files', { offset: 0, limit: 10 })).files.find(file => file.fileName === 'one.wav');
  await call('undoCopy', { copyId: copiedFile.organizedCopyId });
  assert.ok(!fs.existsSync(path.join(library, 'Example', 'Album', 'One (2).wav')));
  assert.equal(fs.readFileSync(collision, 'utf8'), 'keep this existing file');
  await call('playlist', { filePath: playlistPath, batchId: imported.batch.id });
  assert.match(fs.readFileSync(playlistPath, 'utf8'), /music\/one.wav/);
  const removed = await call('removeFile', { itemId: inventory.items[0].id });
  assert.equal(removed, 2);
  const plainChunks = Buffer.concat([riffChunk('fmt ', fmt), riffChunk('data', Buffer.alloc(16000))]);
  const plainHeader = Buffer.alloc(12);
  plainHeader.write('RIFF', 0, 4, 'ascii');
  plainHeader.writeUInt32LE(plainChunks.length + 4, 4);
  plainHeader.write('WAVE', 8, 4, 'ascii');
  fs.writeFileSync(path.join(musicFolder, 'untagged.wav'), Buffer.concat([plainHeader, plainChunks]));
  assert.equal((await call('scan', { folder: musicFolder })).scanned, 1);
  const untagged = (await call('files', { offset: 0, limit: 10 })).files.find(file => file.fileName === 'untagged.wav');
  assert.equal(untagged.suggestions.length, 0);
  assert.equal((await call('inventorySearch', { query: 'Example One' })).length, 1);
  assert.equal(await call('confirmManualFile', { fileId: untagged.id, itemId: inventory.items[0].id }), 2);
  assert.equal((await call('inventory', { offset: 0, limit: 10, batchId: imported.batch.id })).items[0].matchMethod, 'manual');
  const mediaZip = path.join(dir, 'download.zip');
  fs.writeFileSync(mediaZip, Buffer.from(zipSync({ 'Album/one.wav': fs.readFileSync(path.join(musicFolder, 'one.wav')) })));
  const importedMedia = await call('mediaZip', { filePath: mediaZip, folder: dir });
  assert.equal(importedMedia.extracted, 1);
  assert.equal(importedMedia.scan.scanned, 1);
  assert.ok(fs.existsSync(path.join(importedMedia.folder, 'Album', 'one.wav')));
  assert.ok(fs.existsSync(mediaZip));
  const spotifyDir = path.join(dir, 'spotify');
  fs.mkdirSync(spotifyDir);
  fs.writeFileSync(path.join(spotifyDir, 'YourLibrary.json'), JSON.stringify({ tracks: [
    { artist: 'Example', track: 'One', album: 'Album', uri: 'spotify:track:123' },
  ] }));
  fs.writeFileSync(path.join(spotifyDir, 'Playlist1.json'), JSON.stringify({ playlists: [{ name: 'Favorites', items: [
    { track: { artistName: 'Example', trackName: 'One', albumName: 'Album' } },
    { track: { artistName: 'Example', trackName: 'One', albumName: 'Album' } },
  ] }] }));
  fs.writeFileSync(path.join(spotifyDir, 'Payment.json'), JSON.stringify({ card: 'ignored' }));
  const archivePath = path.join(dir, 'account.zip');
  fs.writeFileSync(archivePath, Buffer.from(zipSync(Object.fromEntries(
    ['YourLibrary.json', 'Playlist1.json', 'Payment.json'].map(name =>
      [name, strToU8(fs.readFileSync(path.join(spotifyDir, name), 'utf8'))])))));
  const archiveImport = await call('import', { filePath: archivePath });
  assert.equal(archiveImport.batch.sourceType, 'zip');
  assert.equal(archiveImport.batch.acceptedCount, 3);
  const archivedTracks = await call('inventory', { offset: 0, limit: 10, batchId: archiveImport.batch.id });
  assert.deepEqual(archivedTracks.items.map(item => item.sourceCollection), ['Liked Songs', 'Favorites', 'Favorites']);
  assert.deepEqual(archivedTracks.collections, ['Favorites', 'Liked Songs']);
  const favorites = await call('inventory', { offset: 0, limit: 10, batchId: archiveImport.batch.id, collection: 'Favorites' });
  assert.equal(favorites.totalItems, 2);
  assert.deepEqual(favorites.items.map(item => item.sourceOrder), [2, 3]);
  const favoritesPlaylist = await call('playlist', { filePath: path.join(dir, 'favorites.m3u8'),
    batchId: archiveImport.batch.id, collection: 'Favorites' });
  assert.equal(favoritesPlaylist.unresolved, 2);
  const unsafeArchive = path.join(dir, 'unsafe.zip');
  fs.writeFileSync(unsafeArchive, Buffer.from(zipSync({ '../YourLibrary.json': strToU8('{"tracks":[]}') })));
  await assert.rejects(call('import', { filePath: unsafeArchive }));
  const pendingScan = call('scan', { folder: musicFolder });
  await call('scanCancel');
  assert.equal((await pendingScan).cancelled, true);
  const backupPath = path.join(dir, 'saved-library.sqlite');
  await call('backup', { filePath: backupPath });
  assert.deepEqual(await call('validateBackup', { filePath: backupPath }), { batches: 2, tracks: 5 });
  const invalidBackup = path.join(dir, 'invalid.sqlite');
  fs.writeFileSync(invalidBackup, 'not a database');
  await assert.rejects(call('validateBackup', { filePath: invalidBackup }));
  await call('import', { filePath: source, mapping: { artist: 'Performer', title: 'Work', album: 'Record' } });
  assert.equal((await call('inventory', { offset: 0, limit: 10 })).totalItems, 7);
  await worker.terminate();
  const stagedBackup = path.join(dir, 'staged.sqlite');
  fs.copyFileSync(backupPath, stagedBackup);
  await require('../dist/core/database-recovery.js').replaceDatabaseSnapshot(path.join(dir, 'inventory.sqlite'), stagedBackup);
  worker = new Worker(path.resolve('dist/electron/worker.js'), {
    workerData: { databasePath: path.join(dir, 'inventory.sqlite') },
  });
  assert.equal((await call('inventory', { offset: 0, limit: 10 })).totalItems, 5);
  await worker.terminate();
  const Database = require('better-sqlite3');
  const oldDb = new Database(path.join(dir, 'inventory.sqlite'));
  oldDb.pragma('user_version = 0');
  oldDb.close();
  worker = new Worker(path.resolve('dist/electron/worker.js'), {
    workerData: { databasePath: path.join(dir, 'inventory.sqlite') },
  });
  assert.equal((await call('inventory', { offset: 0, limit: 10 })).totalItems, 5);
  assert.ok(fs.readdirSync(dir).some(name => name.includes('.before-v1-') && name.endsWith('.sqlite')));
  await call('deleteBatch', { batchId: imported.batch.id });
  assert.equal((await call('inventory', { offset: 0, limit: 10 })).totalItems, 3);
  assert.ok(fs.existsSync(backupPath));
  console.log('Worker smoke check passed: inventory, audio ZIP, scan, playlist, backup/restore, migration, and deletion.');
  await worker.terminate();
})().catch(async error => {
  console.error(error);
  await worker.terminate();
  process.exitCode = 1;
});
