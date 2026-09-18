import { parentPort, workerData } from 'node:worker_threads';
import { copyFile, link, lstat, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { parseInventory, previewCsv } from '../core/importers';
import { readSpotifyArchive } from '../core/spotify-export';
import { sameSourceRecording, sourceRecordingKey, suggestFiles } from '../core/file-matcher';
import { makeM3u8 } from '../core/playlist';
import { safeMusicSegment } from '../core/library-files';
import { extractMediaArchive } from '../core/media-archive';
import { planPurchases, type PurchaseOffer, type WantedRecording } from '../core/purchase-planner';
import { normalizeMusicText } from '../core/file-matcher';
import { freshCatalogObservation, searchApple } from '../core/providers/apple';
import type { CatalogCandidate, CatalogSearch, CatalogStatus, ColumnMapping, DiscoveryProgress, FileAsset, FileInventory, ImportBatch, ImportError, ImportResult, InventorySnapshot, OrganizeResult, PlaylistExportResult, PurchasePlanView, ScanResult, SourceItem } from '../shared/types';

if (!parentPort) throw new Error('Inventory worker requires a parent.');
const db = new Database(workerData.databasePath as string);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const schemaVersion = db.pragma('user_version', { simple: true }) as number;
const existingSchema = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_items'").get();
if (schemaVersion > 1) throw new Error('This database was created by a newer Wayveform version.');
if (schemaVersion < 1 && existingSchema) {
  const backupPath = `${workerData.databasePath as string}.before-v1-${Date.now()}.sqlite`;
  // VACUUM INTO includes committed WAL pages in one consistent snapshot.
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY, file_name TEXT NOT NULL, source_type TEXT NOT NULL,
    input_hash TEXT NOT NULL, imported_at TEXT NOT NULL,
    input_count INTEGER NOT NULL, accepted_count INTEGER NOT NULL,
    rejected_count INTEGER NOT NULL, duplicate_count INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_items (
    id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES import_batches(id),
    source_order INTEGER NOT NULL, artist TEXT NOT NULL, title TEXT NOT NULL,
    album TEXT, duration_ms INTEGER, isrc TEXT, source_collection TEXT, original_values TEXT NOT NULL,
    UNIQUE(batch_id, source_order)
  );
  CREATE TABLE IF NOT EXISTS import_errors (
    batch_id TEXT NOT NULL REFERENCES import_batches(id),
    source_order INTEGER NOT NULL, message TEXT NOT NULL, original_values TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS source_items_batch_order ON source_items(batch_id, source_order);
  CREATE TABLE IF NOT EXISTS file_assets (
    id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL,
    folder_name TEXT NOT NULL, size_bytes INTEGER NOT NULL, modified_at_ms REAL NOT NULL,
    sha256 TEXT NOT NULL, format TEXT, duration_ms INTEGER,
    artist TEXT, title TEXT, album TEXT, scanned_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS file_matches (
    source_item_id TEXT PRIMARY KEY REFERENCES source_items(id) ON DELETE CASCADE,
    file_asset_id TEXT NOT NULL REFERENCES file_assets(id), matched_at TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'tag_review'
  );
  CREATE INDEX IF NOT EXISTS file_matches_asset ON file_matches(file_asset_id);
  CREATE TABLE IF NOT EXISTS catalog_searches (
    item_id TEXT PRIMARY KEY REFERENCES source_items(id) ON DELETE CASCADE,
    status TEXT NOT NULL, message TEXT, fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS catalog_candidates (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
    provider TEXT NOT NULL, provider_track_id TEXT NOT NULL,
    artist TEXT NOT NULL, title TEXT NOT NULL, album TEXT, duration_ms INTEGER,
    price_minor INTEGER, currency TEXT, country TEXT NOT NULL, store_url TEXT NOT NULL,
    match_level TEXT NOT NULL, reason TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0,
    UNIQUE(item_id, provider, provider_track_id)
  );
  CREATE INDEX IF NOT EXISTS catalog_candidates_item ON catalog_candidates(item_id);
  CREATE TABLE IF NOT EXISTS provider_cache (
    query_key TEXT PRIMARY KEY, response_json TEXT NOT NULL, fetched_at_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS provider_state (
    provider TEXT PRIMARY KEY, next_allowed_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS discovery_jobs (
    item_id TEXT PRIMARY KEY REFERENCES source_items(id) ON DELETE CASCADE,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_retry_ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS discovery_control (
    id INTEGER PRIMARY KEY CHECK (id = 1), active INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO discovery_control VALUES (1, 0);
  CREATE TABLE IF NOT EXISTS purchase_records (
    item_id TEXT PRIMARY KEY REFERENCES source_items(id) ON DELETE CASCADE,
    provider TEXT NOT NULL, provider_track_id TEXT NOT NULL,
    status TEXT NOT NULL, opened_at TEXT, confirmed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS library_copies (
    id TEXT PRIMARY KEY, file_asset_id TEXT NOT NULL REFERENCES file_assets(id),
    destination_root TEXT NOT NULL, destination_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, modified_at_ms REAL NOT NULL,
    copied_at TEXT NOT NULL, UNIQUE(file_asset_id, destination_root)
  );
`);
db.prepare("UPDATE discovery_jobs SET status = 'pending' WHERE status = 'running'").run();
const columns = db.pragma('table_info(source_items)') as { name: string }[];
if (!columns.some(column => column.name === 'original_values')) {
  db.exec("ALTER TABLE source_items ADD COLUMN original_values TEXT NOT NULL DEFAULT '{}'");
}
const errorColumns = db.pragma('table_info(import_errors)') as { name: string }[];
if (!errorColumns.some(column => column.name === 'original_values')) {
  db.exec("ALTER TABLE import_errors ADD COLUMN original_values TEXT NOT NULL DEFAULT '{}'");
}
const matchColumns = db.pragma('table_info(file_matches)') as { name: string }[];
if (!matchColumns.some(column => column.name === 'method')) {
  db.exec("ALTER TABLE file_matches ADD COLUMN method TEXT NOT NULL DEFAULT 'tag_review'");
}
db.pragma('user_version = 1');

async function previewFile(filePath: string) {
  const content = await readFile(filePath, 'utf8');
  return previewCsv(content);
}

function importFile(filePath: string, mapping?: ColumnMapping, expectedHash?: string): Promise<ImportResult> {
  const extension = extname(filePath).slice(1).toLowerCase();
  if (extension !== 'csv' && extension !== 'json' && extension !== 'zip') throw new Error('Choose a CSV, JSON, or Spotify account-data ZIP.');
  return importFileAsync(filePath, extension, mapping, expectedHash);
}

async function importFileAsync(filePath: string, extension: 'csv' | 'json' | 'zip', mapping?: ColumnMapping, expectedHash?: string): Promise<ImportResult> {
  const id = randomUUID();
  const archive = extension === 'zip' ? await readSpotifyArchive(filePath) : null;
  const content = archive ? JSON.stringify(archive.rows) : await readFile(filePath, 'utf8');
  const parsed = parseInventory(content, archive ? 'json' : extension as 'csv' | 'json', id, mapping);
  if (archive) parsed.inputHash = archive.inputHash;
  if (expectedHash && parsed.inputHash !== expectedHash) throw new Error('The CSV file changed after preview. Choose it again.');
  const batch: ImportBatch = {
    id, fileName: basename(filePath), sourceType: extension, importedAt: new Date().toISOString(),
    inputCount: parsed.inputCount, acceptedCount: parsed.items.length,
    rejectedCount: parsed.errors.length, duplicateCount: parsed.duplicateCount,
  };
  const write = db.transaction(() => {
    db.prepare(`INSERT INTO import_batches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      batch.id, batch.fileName, batch.sourceType, parsed.inputHash, batch.importedAt,
      batch.inputCount, batch.acceptedCount, batch.rejectedCount, batch.duplicateCount);
    const insertItem = db.prepare(`INSERT INTO source_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of parsed.items) insertItem.run(item.id, item.batchId, item.sourceOrder,
      item.artist, item.title, item.album, item.durationMs, item.isrc, item.sourceCollection,
      JSON.stringify(item.originalValues));
    const insertError = db.prepare(`INSERT INTO import_errors VALUES (?, ?, ?, ?)`);
    for (const error of parsed.errors) insertError.run(id, error.sourceOrder, error.message, JSON.stringify(error.originalValues ?? {}));
  });
  write();
  return { batch, errors: parsed.errors };
}

function getBatches(): ImportBatch[] {
  return db.prepare(`SELECT id, file_name AS fileName, source_type AS sourceType,
    imported_at AS importedAt, input_count AS inputCount, accepted_count AS acceptedCount,
    rejected_count AS rejectedCount, duplicate_count AS duplicateCount
    FROM import_batches ORDER BY imported_at DESC`).all() as ImportBatch[];
}

function getItems(batchId?: string | null, offset?: number, limit?: number, collection?: string | null): SourceItem[] {
  const filters = [batchId ? 'i.batch_id = ?' : '', collection ? 'i.source_collection = ?' : ''].filter(Boolean);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const page = limit !== undefined ? 'LIMIT ? OFFSET ?' : '';
  const arguments_ = [...(batchId ? [batchId] : []), ...(collection ? [collection] : []),
    ...(limit !== undefined ? [limit, offset ?? 0] : [])];
  const rows = db.prepare(`SELECT i.id, i.batch_id AS batchId, i.source_order AS sourceOrder,
    i.artist, i.title, i.album, i.duration_ms AS durationMs, i.isrc,
    i.source_collection AS sourceCollection, i.original_values AS originalValues,
    m.file_asset_id AS matchedFileId, f.file_name AS matchedFileName,
    m.method AS matchMethod,
    c.status AS catalogStatus, p.status AS purchaseStatus FROM source_items i
    JOIN import_batches b ON b.id = i.batch_id
    LEFT JOIN file_matches m ON m.source_item_id = i.id
    LEFT JOIN file_assets f ON f.id = m.file_asset_id
    LEFT JOIN catalog_searches c ON c.item_id = i.id
    LEFT JOIN purchase_records p ON p.item_id = i.id
    ${where}
    ORDER BY b.imported_at DESC, i.source_order ASC ${page}`).all(...arguments_) as (Omit<SourceItem, 'originalValues'> & { originalValues: string })[];
  return rows.map(item => ({ ...item, originalValues: JSON.parse(item.originalValues) }));
}

function getItemById(itemId: string): SourceItem | null {
  const row = db.prepare(`SELECT id, batch_id AS batchId, source_order AS sourceOrder, artist, title,
    album, duration_ms AS durationMs, isrc, source_collection AS sourceCollection,
    original_values AS originalValues FROM source_items WHERE id = ?`).get(itemId) as
    (Omit<SourceItem, 'originalValues'> & { originalValues: string }) | undefined;
  return row ? { ...row, originalValues: JSON.parse(row.originalValues) } : null;
}

function getInventory(offset: number, limit: number, batchId?: string | null, collection?: string | null): InventorySnapshot {
  const filters = [batchId ? 'batch_id = ?' : '', collection ? 'source_collection = ?' : ''].filter(Boolean);
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const totalItems = (db.prepare(`SELECT COUNT(*) AS count FROM source_items ${where}`)
    .get(...(batchId ? [batchId] : []), ...(collection ? [collection] : [])) as { count: number }).count;
  const collections = db.prepare(`SELECT DISTINCT source_collection AS name FROM source_items
    WHERE source_collection IS NOT NULL AND source_collection != '' ${batchId ? 'AND batch_id = ?' : ''}
    ORDER BY name`).all(...(batchId ? [batchId] : [])) as { name: string }[];
  return { batches: getBatches(), collections: collections.map(row => row.name),
    items: getItems(batchId, offset, limit, collection), totalItems };
}

function getBatchErrors(batchId: string): ImportError[] {
  const rows = db.prepare(`SELECT source_order AS sourceOrder, message, original_values AS originalValues
    FROM import_errors WHERE batch_id = ? ORDER BY source_order`).all(batchId) as (Omit<ImportError, 'originalValues'> & { originalValues: string })[];
  return rows.map(row => ({ ...row, originalValues: JSON.parse(row.originalValues) }));
}

function deleteBatch(batchId: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM source_items WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM import_errors WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM import_batches WHERE id = ?').run(batchId);
    // Query keys contain artist/title text, so clear the provider cache after a deletion.
    db.prepare('DELETE FROM provider_cache').run();
  })();
}

function backupDatabase(filePath: string): string {
  db.exec(`VACUUM INTO '${filePath.replaceAll("'", "''")}'`);
  return basename(filePath);
}

function validateBackup(filePath: string): { batches: number; tracks: number } {
  const source = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const version = source.pragma('user_version', { simple: true }) as number;
    if (version > 1) throw new Error('This backup was made by a newer Wayveform version.');
    if (source.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('This backup did not pass the database integrity check.');
    for (const table of ['import_batches', 'source_items', 'file_assets']) {
      if (!source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
        throw new Error('This file is not a Wayveform database backup.');
    }
    const batches = (source.prepare('SELECT COUNT(*) AS count FROM import_batches').get() as { count: number }).count;
    const tracks = (source.prepare('SELECT COUNT(*) AS count FROM source_items').get() as { count: number }).count;
    return { batches, tracks };
  } finally { source.close(); }
}

function csvCell(value: unknown): string {
  let cell = value === null || value === undefined ? '' : String(value);
  if (/^\s*[=+\-@]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
}

async function exportInventory(filePath: string, format: 'csv' | 'json', batchId?: string | null): Promise<string> {
  const items = getItems(batchId);
  const batches = getBatches().filter(batch => !batchId || batch.id === batchId);
  if (format === 'json') {
    const errors = batches.flatMap(batch => getBatchErrors(batch.id).map(error => ({ batchId: batch.id, ...error })));
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), batches, items, errors }, null, 2), 'utf8');
  } else {
    const header = ['Batch', 'Order', 'Artist', 'Title', 'Album', 'Duration (ms)', 'ISRC', 'Collection'];
    const rows = items.map(item => [item.batchId, item.sourceOrder, item.artist, item.title, item.album,
      item.durationMs, item.isrc, item.sourceCollection]);
    await writeFile(filePath, '\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');
  }
  return basename(filePath);
}

const audioExtensions = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.alac', '.wma']);
const maxScanFiles = 50000;
const maxScanDepth = 20;
let scanRunning = false;
let scanCancelRequested = false;

async function* audioPaths(folder: string, depth = 0): AsyncGenerator<string> {
  if (depth > maxScanDepth) return;
  const entries = await readdir(folder, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const filePath = join(folder, entry.name);
    if (entry.isDirectory()) yield* audioPaths(filePath, depth + 1);
    else if (entry.isFile() && audioExtensions.has(extname(entry.name).toLowerCase())) yield filePath;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function scanFolder(folder: string): Promise<ScanResult> {
  if (scanRunning) throw new Error('A music folder scan is already running.');
  scanRunning = true;
  scanCancelRequested = false;
  try {
  if (!(await lstat(folder)).isDirectory()) throw new Error('Choose a music folder.');
  const { parseFile } = await import('music-metadata');
  const result: ScanResult = { scanned: 0, skipped: 0, failed: 0, errors: [] };
  let encountered = 0;
  for await (const filePath of audioPaths(folder)) {
    if (scanCancelRequested) { result.cancelled = true; break; }
    encountered++;
    if (encountered > maxScanFiles) {
      result.errors.push(`Stopped after ${maxScanFiles} audio files. Choose a smaller folder.`);
      break;
    }
    try {
      const before = await lstat(filePath);
      if (!before.isFile() || before.isSymbolicLink()) { result.skipped++; continue; }
      const existing = db.prepare('SELECT id, size_bytes AS sizeBytes, modified_at_ms AS modifiedAtMs, sha256 FROM file_assets WHERE path = ?')
        .get(filePath) as { id: string; sizeBytes: number; modifiedAtMs: number; sha256: string } | undefined;
      if (existing && existing.sizeBytes === before.size && existing.modifiedAtMs === before.mtimeMs) { result.skipped++; continue; }
      const metadata = await parseFile(filePath, { skipCovers: true, duration: true });
      const sha256 = await hashFile(filePath);
      const after = await stat(filePath);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) { result.skipped++; continue; }
      const asset = {
        id: existing?.id ?? randomUUID(), path: filePath, fileName: basename(filePath),
        folderName: basename(dirname(filePath)), sizeBytes: after.size, modifiedAtMs: after.mtimeMs,
        sha256, format: metadata.format.container ?? null,
        durationMs: metadata.format.duration ? Math.round(metadata.format.duration * 1000) : null,
        artist: metadata.common.artist ?? null, title: metadata.common.title ?? null,
        album: metadata.common.album ?? null, scannedAt: new Date().toISOString(),
      };
      db.transaction(() => {
        if (existing && existing.sha256 !== sha256) db.prepare('DELETE FROM file_matches WHERE file_asset_id = ?').run(existing.id);
        db.prepare(`INSERT INTO file_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET file_name = excluded.file_name, folder_name = excluded.folder_name,
          size_bytes = excluded.size_bytes, modified_at_ms = excluded.modified_at_ms, sha256 = excluded.sha256,
          format = excluded.format, duration_ms = excluded.duration_ms, artist = excluded.artist,
          title = excluded.title, album = excluded.album, scanned_at = excluded.scanned_at`).run(
          asset.id, asset.path, asset.fileName, asset.folderName, asset.sizeBytes, asset.modifiedAtMs,
          asset.sha256, asset.format, asset.durationMs, asset.artist, asset.title, asset.album, asset.scannedAt);
      })();
      result.scanned++;
    } catch (error) {
      result.failed++;
      if (result.errors.length < 20) result.errors.push(`${basename(filePath)}: ${error instanceof Error ? error.message : 'Could not inspect file.'}`);
    } finally {
      if (encountered % 10 === 0) parentPort!.postMessage({ event: 'scanProgress', progress: result });
    }
  }
  return result;
  } finally { scanRunning = false; }
}

async function ingestMediaZip(filePath: string, folder: string) {
  if (scanRunning) throw new Error('Finish the current scan before importing an audio ZIP.');
  const archive = await extractMediaArchive(filePath, folder);
  return { ...archive, scan: await scanFolder(archive.folder) };
}

function cancelScan() { scanCancelRequested = true; }

function getFiles(offset: number, limit: number): FileInventory {
  const totalFiles = (db.prepare('SELECT COUNT(*) AS count FROM file_assets').get() as { count: number }).count;
  const files = db.prepare(`SELECT f.id, f.file_name AS fileName, f.folder_name AS folderName,
    f.size_bytes AS sizeBytes, f.modified_at_ms AS modifiedAtMs, f.sha256, f.format,
    f.duration_ms AS durationMs, f.artist, f.title, f.album, f.scanned_at AS scannedAt,
    COUNT(m.source_item_id) AS matchCount,
    (SELECT id FROM library_copies WHERE file_asset_id = f.id ORDER BY copied_at DESC LIMIT 1) AS organizedCopyId,
    (SELECT destination_path FROM library_copies WHERE file_asset_id = f.id ORDER BY copied_at DESC LIMIT 1) AS organizedPath
    FROM file_assets f
    LEFT JOIN file_matches m ON m.file_asset_id = f.id
    GROUP BY f.id ORDER BY f.scanned_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as (FileAsset & { organizedPath: string | null })[];
  const items = getItems().filter(item => !item.matchedFileId);
  return { totalFiles, files: files.map(file => ({ ...file, organizedPath: undefined,
    organizedFileName: file.organizedPath ? basename(file.organizedPath) : null,
    suggestions: suggestFiles(file, items) })) };
}

async function confirmFileMatch(fileId: string, itemId: string, manual = false): Promise<number> {
  const file = db.prepare(`SELECT id, path, size_bytes AS sizeBytes, modified_at_ms AS modifiedAtMs,
    artist, title, album, duration_ms AS durationMs FROM file_assets WHERE id = ?`).get(fileId) as
    (FileAsset & { path: string }) | undefined;
  if (!file) throw new Error('The scanned file was not found.');
  const current = await lstat(file.path);
  if (!current.isFile() || current.isSymbolicLink() || current.size !== file.sizeBytes
    || current.mtimeMs !== file.modifiedAtMs) throw new Error('The file changed after scanning. Scan it again.');
  const items = getItems();
  const chosen = items.find(item => item.id === itemId);
  if (!chosen || (!manual && !suggestFiles(file, [chosen]).length))
    throw new Error('The file and track do not match closely enough. Use a manual link after reviewing them.');
  if (chosen.matchedFileId) throw new Error('This track is already linked to a file.');
  const duplicates = items.filter(item => sameSourceRecording(chosen, item) && !item.matchedFileId);
  const insert = db.prepare('INSERT OR IGNORE INTO file_matches VALUES (?, ?, ?, ?)');
  return db.transaction(() => duplicates.reduce((count, item) => count + insert.run(item.id, fileId,
    new Date().toISOString(), manual ? 'manual' : 'tag_review').changes, 0))();
}

function searchInventory(query: string) {
  const needle = normalizeMusicText(query).slice(0, 80);
  if (!needle) return [];
  const seen = new Set<string>();
  return getItems().filter(item => {
    if (item.matchedFileId) return false;
    const key = sourceRecordingKey(item);
    if (seen.has(key)) return false;
    const match = normalizeMusicText(`${item.artist} ${item.title} ${item.album ?? ''}`).includes(needle);
    if (match) seen.add(key);
    return match;
  }).slice(0, 30).map(item => ({ itemId: item.id, artist: item.artist, title: item.title,
    album: item.album, reason: 'Manual selection; inspect the file and recording before linking.' }));
}

function removeFileMatch(itemId: string): number {
  const items = getItems();
  const chosen = items.find(item => item.id === itemId);
  if (!chosen?.matchedFileId) return 0;
  const duplicates = items.filter(item => item.matchedFileId === chosen.matchedFileId && sameSourceRecording(chosen, item));
  const remove = db.prepare('DELETE FROM file_matches WHERE source_item_id = ?');
  return db.transaction(() => duplicates.reduce((count, item) => count + remove.run(item.id).changes, 0))();
}

async function exportPlaylist(filePath: string, batchId?: string | null, collection?: string | null): Promise<PlaylistExportResult> {
  const items = getItems(batchId, undefined, undefined, collection);
  const linked = db.prepare(`SELECT f.path, f.size_bytes AS sizeBytes, f.modified_at_ms AS modifiedAtMs
    FROM file_assets f WHERE f.id = ?`);
  const copied = db.prepare(`SELECT destination_path AS path, size_bytes AS sizeBytes,
    modified_at_ms AS modifiedAtMs FROM library_copies WHERE file_asset_id = ? ORDER BY copied_at DESC LIMIT 1`);
  const entries = [];
  for (const item of items) {
    let path: string | null = null;
    let unavailable = false;
    if (item.matchedFileId) {
      const organized = copied.get(item.matchedFileId) as { path: string; sizeBytes: number; modifiedAtMs: number } | undefined;
      const asset = linked.get(item.matchedFileId) as { path: string; sizeBytes: number; modifiedAtMs: number } | undefined;
      for (const candidate of [organized, asset]) {
        if (!candidate || path) continue;
        try {
          const current = await stat(candidate.path);
          if (current.size === candidate.sizeBytes && current.mtimeMs === candidate.modifiedAtMs) path = candidate.path;
          else unavailable = true;
        } catch { unavailable = true; }
      }
      if (!path) unavailable = true;
    }
    entries.push({ artist: item.artist, title: item.title, durationMs: item.durationMs, filePath: path, unavailable });
  }
  const playlist = makeM3u8(entries, filePath);
  await writeFile(filePath, playlist.text, 'utf8');
  return { fileName: basename(filePath), included: playlist.included, unresolved: playlist.unresolved, unavailable: playlist.unavailable };
}

async function safeDirectory(parent: string, segment: string): Promise<string> {
  const destination = join(parent, segment);
  await mkdir(destination).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const info = await lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Destination contains an unsafe directory link.');
  return destination;
}

async function organizeLinkedFiles(destinationRoot: string): Promise<OrganizeResult> {
  const rootInfo = await lstat(destinationRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Choose a regular destination folder.');
  const assets = db.prepare(`SELECT f.id, f.path, f.file_name AS fileName, f.size_bytes AS sizeBytes,
    f.modified_at_ms AS modifiedAtMs, f.sha256, i.artist, i.album, i.title
    FROM file_assets f JOIN file_matches m ON m.file_asset_id = f.id
    JOIN source_items i ON i.id = m.source_item_id GROUP BY f.id`)
    .all() as { id: string; path: string; fileName: string; sizeBytes: number; modifiedAtMs: number;
      sha256: string; artist: string; album: string | null; title: string }[];
  const result: OrganizeResult = { copied: 0, skipped: 0, failed: 0, errors: [] };
  for (const asset of assets) {
    try {
      const existing = db.prepare(`SELECT destination_path AS path FROM library_copies
        WHERE file_asset_id = ? AND destination_root = ?`).get(asset.id, destinationRoot) as { path: string } | undefined;
      if (existing) {
        try {
          if (await hashFile(existing.path) === asset.sha256) { result.skipped++; continue; }
          throw new Error('An existing organized copy has changed; review it before copying again.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const sourceInfo = await lstat(asset.path);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== asset.sizeBytes
        || sourceInfo.mtimeMs !== asset.modifiedAtMs) throw new Error('Source file changed after scanning.');
      const artistDir = await safeDirectory(destinationRoot, safeMusicSegment(asset.artist, 'Unknown Artist'));
      const albumDir = await safeDirectory(artistDir, safeMusicSegment(asset.album, 'Unknown Album'));
      const extension = extname(asset.fileName).toLowerCase();
      const title = safeMusicSegment(asset.title, 'Untitled');
      const staged = join(albumDir, `.wayveform-${randomUUID()}.part`);
      let destination: string | null = null;
      try {
        await copyFile(asset.path, staged, fsConstants.COPYFILE_EXCL);
        if (await hashFile(staged) !== asset.sha256) throw new Error('Copied bytes differ from the scanned file.');
        for (let suffix = 1; suffix <= 1000; suffix++) {
          const name = `${title}${suffix === 1 ? '' : ` (${suffix})`}${extension}`;
          const candidate = join(albumDir, name);
          try {
            await link(staged, candidate);
            destination = candidate;
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw error;
          }
        }
        if (!destination) throw new Error('Too many files share this title in the destination.');
        const copied = await stat(destination);
        try { db.prepare(`INSERT INTO library_copies VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(file_asset_id, destination_root) DO UPDATE SET
            destination_path = excluded.destination_path, sha256 = excluded.sha256,
            size_bytes = excluded.size_bytes, modified_at_ms = excluded.modified_at_ms,
            copied_at = excluded.copied_at`).run(randomUUID(), asset.id, destinationRoot,
            destination, asset.sha256, copied.size, copied.mtimeMs, new Date().toISOString()); }
        catch (error) { await unlink(destination); throw error; }
        result.copied++;
      } finally { await unlink(staged).catch(() => undefined); }
    } catch (error) {
      result.failed++;
      if (result.errors.length < 20) result.errors.push(`${asset.fileName}: ${error instanceof Error ? error.message : 'Could not copy file.'}`);
    }
  }
  return result;
}

async function undoOrganizedCopy(copyId: string): Promise<void> {
  const copy = db.prepare('SELECT destination_path AS path, sha256 FROM library_copies WHERE id = ?')
    .get(copyId) as { path: string; sha256: string } | undefined;
  if (!copy) throw new Error('Organized copy was not found.');
  try {
    const info = await lstat(copy.path);
    if (!info.isFile() || info.isSymbolicLink() || await hashFile(copy.path) !== copy.sha256)
      throw new Error('The organized copy changed; it will not be removed.');
    await unlink(copy.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  db.prepare('DELETE FROM library_copies WHERE id = ?').run(copyId);
}

function getCatalog(itemId: string): CatalogSearch {
  const search = db.prepare(`SELECT status, message, fetched_at AS fetchedAt FROM catalog_searches WHERE item_id = ?`)
    .get(itemId) as { status: CatalogStatus; message: string | null; fetchedAt: string } | undefined;
  const candidates = db.prepare(`SELECT c.id, c.item_id AS itemId, c.provider,
    c.provider_track_id AS providerTrackId, c.artist, c.title, c.album,
    c.duration_ms AS durationMs, c.price_minor AS priceMinor,
    c.currency, c.country, c.store_url AS storeUrl, c.match_level AS matchLevel, c.reason, c.accepted,
    p.status AS purchaseStatus
    FROM catalog_candidates c LEFT JOIN purchase_records p
      ON p.item_id = c.item_id AND p.provider = c.provider AND p.provider_track_id = c.provider_track_id
    WHERE c.item_id = ? ORDER BY
    CASE c.match_level WHEN 'strong' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, c.price_minor ASC`)
    .all(itemId) as (Omit<CatalogCandidate, 'accepted'> & { accepted: number })[];
  return { itemId, status: search?.status ?? 'notSearched', message: search?.message ?? null,
    fetchedAt: search?.fetchedAt ?? null, candidates: candidates.map(candidate => ({ ...candidate, accepted: !!candidate.accepted })) };
}

function saveCatalog(itemId: string, outcome: { status: CatalogStatus; message: string | null; candidates: CatalogCandidate[] },
  observedAtMs = Date.now()): CatalogSearch {
  const priorAccepted = (db.prepare(`SELECT provider_track_id AS providerTrackId FROM catalog_candidates
    WHERE item_id = ? AND accepted = 1`).get(itemId) as { providerTrackId: string } | undefined)?.providerTrackId;
  const now = new Date(observedAtMs).toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO catalog_searches VALUES (?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET status = excluded.status, message = excluded.message,
      fetched_at = excluded.fetched_at`).run(itemId, outcome.status, outcome.message, now);
    if (outcome.status === 'ready' || outcome.status === 'noCandidates') {
      db.prepare('DELETE FROM catalog_candidates WHERE item_id = ?').run(itemId);
      const insert = db.prepare(`INSERT INTO catalog_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const candidate of outcome.candidates) {
        const accepted = priorAccepted === candidate.providerTrackId && candidate.matchLevel !== 'conflict' ? 1 : 0;
        insert.run(candidate.id, itemId, candidate.provider, candidate.providerTrackId,
          candidate.artist, candidate.title, candidate.album, candidate.durationMs,
          candidate.priceMinor, candidate.currency, candidate.country, candidate.storeUrl,
          candidate.matchLevel, candidate.reason, accepted);
      }
    }
  })();
  return getCatalog(itemId);
}

let appleSearchQueue: Promise<unknown> = Promise.resolve();
function searchCatalog(itemId: string): Promise<CatalogSearch> {
  const task = appleSearchQueue.then(async () => {
    const item = getItemById(itemId);
    if (!item) throw new Error('Track was not found.');
    const queryKey = `apple:US:${normalizeMusicText(item.artist)}:${normalizeMusicText(item.title)}`;
    const cache = db.prepare('SELECT response_json AS responseJson, fetched_at_ms AS fetchedAtMs FROM provider_cache WHERE query_key = ?')
      .get(queryKey) as { responseJson: string; fetchedAtMs: number } | undefined;
    if (cache && Date.now() - cache.fetchedAtMs < 6 * 60 * 60 * 1000) {
      const cached = JSON.parse(cache.responseJson) as { status: CatalogStatus; message: string | null; candidates: CatalogCandidate[] };
      return saveCatalog(itemId, { ...cached, candidates: cached.candidates.map(candidate => ({ ...candidate,
        id: randomUUID(), itemId, accepted: false })) }, cache.fetchedAtMs);
    }
    const state = db.prepare('SELECT next_allowed_ms AS nextAllowedMs FROM provider_state WHERE provider = ?')
      .get('apple') as { nextAllowedMs: number } | undefined;
    const delay = Math.max(0, (state?.nextAllowedMs ?? 0) - Date.now());
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    db.prepare(`INSERT INTO provider_state VALUES ('apple', ?)
      ON CONFLICT(provider) DO UPDATE SET next_allowed_ms = excluded.next_allowed_ms`).run(Date.now() + 3200);
    const outcome = await searchApple(item);
    if (outcome.status === 'rateLimited') db.prepare('UPDATE provider_state SET next_allowed_ms = ? WHERE provider = ?')
      .run(Date.now() + (outcome.retryAfterMs ?? 60000), 'apple');
    if (outcome.status === 'ready' || outcome.status === 'noCandidates') {
      db.prepare(`INSERT INTO provider_cache VALUES (?, ?, ?)
        ON CONFLICT(query_key) DO UPDATE SET response_json = excluded.response_json, fetched_at_ms = excluded.fetched_at_ms`)
        .run(queryKey, JSON.stringify(outcome), Date.now());
    }
    return saveCatalog(itemId, outcome);
  });
  appleSearchQueue = task.then(() => undefined, () => undefined);
  return task;
}

function acceptCatalogCandidate(itemId: string, candidateId: string): void {
  const candidate = db.prepare('SELECT id, provider_track_id AS providerTrackId FROM catalog_candidates WHERE id = ? AND item_id = ?')
    .get(candidateId, itemId) as { id: string; providerTrackId: string } | undefined;
  if (!candidate) throw new Error('Candidate was not found for this track.');
  const items = getItems();
  const chosen = items.find(item => item.id === itemId);
  if (!chosen) throw new Error('Track was not found.');
  const purchase = db.prepare('SELECT provider_track_id AS providerTrackId, status FROM purchase_records WHERE item_id = ?')
    .get(itemId) as { providerTrackId: string; status: string } | undefined;
  if (purchase?.status === 'userConfirmed' && purchase.providerTrackId !== candidate.providerTrackId)
    throw new Error('Undo the purchase confirmation before choosing another recording.');
  const duplicates = items.filter(item => sameSourceRecording(chosen, item));
  db.transaction(() => {
    for (const item of duplicates) {
      const matching = db.prepare(`SELECT id FROM catalog_candidates WHERE item_id = ? AND provider_track_id = ?`)
        .get(item.id, candidate.providerTrackId);
      if (!matching) continue;
      db.prepare("DELETE FROM purchase_records WHERE item_id = ? AND status = 'opened' AND provider_track_id != ?")
        .run(item.id, candidate.providerTrackId);
      db.prepare('UPDATE catalog_candidates SET accepted = 0 WHERE item_id = ?').run(item.id);
      db.prepare('UPDATE catalog_candidates SET accepted = 1 WHERE item_id = ? AND provider_track_id = ?')
        .run(item.id, candidate.providerTrackId);
    }
  })();
}

function storeCandidateUrl(candidateId: string): string {
  const row = db.prepare(`SELECT c.store_url AS storeUrl, s.fetched_at AS fetchedAt
    FROM catalog_candidates c JOIN catalog_searches s ON s.item_id = c.item_id
    WHERE c.id = ? AND c.accepted = 1`)
    .get(candidateId) as { storeUrl: string; fetchedAt: string } | undefined;
  if (!row) throw new Error('Accept the recording match before opening the store.');
  if (!freshCatalogObservation(row.fetchedAt)) throw new Error('This catalog quote is older than six hours. Refresh the Apple results before opening the store.');
  return row.storeUrl;
}

function setPurchaseStatus(candidateId: string, status: 'opened' | 'userConfirmed'): void {
  const candidate = db.prepare(`SELECT item_id AS itemId, provider, provider_track_id AS providerTrackId
    FROM catalog_candidates WHERE id = ? AND accepted = 1`).get(candidateId) as
    { itemId: string; provider: string; providerTrackId: string } | undefined;
  if (!candidate) throw new Error('Accept the recording match first.');
  const items = getItems();
  const chosen = items.find(item => item.id === candidate.itemId)!;
  const duplicates = items.filter(item => sameSourceRecording(chosen, item));
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const item of duplicates) {
      const accepted = db.prepare(`SELECT id FROM catalog_candidates WHERE item_id = ?
        AND provider = ? AND provider_track_id = ? AND accepted = 1`)
        .get(item.id, candidate.provider, candidate.providerTrackId);
      if (!accepted) continue;
      db.prepare(`INSERT INTO purchase_records VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          provider = excluded.provider, provider_track_id = excluded.provider_track_id,
          status = CASE WHEN purchase_records.status = 'userConfirmed' AND excluded.status = 'opened'
            THEN purchase_records.status ELSE excluded.status END,
          opened_at = COALESCE(purchase_records.opened_at, excluded.opened_at),
          confirmed_at = CASE WHEN excluded.status = 'userConfirmed' THEN excluded.confirmed_at
            ELSE purchase_records.confirmed_at END`).run(
          item.id, candidate.provider, candidate.providerTrackId, status,
          status === 'opened' ? now : null, status === 'userConfirmed' ? now : null);
    }
  })();
}

function undoPurchaseConfirmation(candidateId: string): void {
  const candidate = db.prepare(`SELECT item_id AS itemId, provider_track_id AS providerTrackId FROM catalog_candidates
    WHERE id = ? AND accepted = 1`).get(candidateId) as { itemId: string; providerTrackId: string } | undefined;
  if (!candidate) throw new Error('Accepted recording was not found.');
  const items = getItems();
  const chosen = items.find(item => item.id === candidate.itemId)!;
  const duplicates = items.filter(item => sameSourceRecording(chosen, item));
  db.transaction(() => {
    for (const item of duplicates) db.prepare(`UPDATE purchase_records SET status = 'opened', confirmed_at = NULL
      WHERE item_id = ? AND provider_track_id = ?`).run(item.id, candidate.providerTrackId);
  })();
}

function getDiscoveryProgress(): DiscoveryProgress {
  const counts = db.prepare(`SELECT status, COUNT(*) AS count FROM discovery_jobs GROUP BY status`)
    .all() as { status: string; count: number }[];
  const count = (status: string) => counts.find(row => row.status === status)?.count ?? 0;
  const queued = count('pending') + count('running');
  const completed = count('completed');
  const failed = count('failed');
  const active = !!(db.prepare('SELECT active FROM discovery_control WHERE id = 1').get() as { active: number }).active;
  return { active, queued, completed, failed, total: queued + completed + failed };
}

let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
let discoveryPumping = false;
function scheduleDiscovery(delayMs = 0) {
  if (discoveryTimer) clearTimeout(discoveryTimer);
  discoveryTimer = setTimeout(() => { discoveryTimer = null; void pumpDiscovery(); }, delayMs);
}

async function pumpDiscovery() {
  if (discoveryPumping) return;
  discoveryPumping = true;
  try {
    const active = (db.prepare('SELECT active FROM discovery_control WHERE id = 1').get() as { active: number }).active;
    if (!active) return;
    const next = db.prepare(`SELECT item_id AS itemId, attempts FROM discovery_jobs
      WHERE status = 'pending' AND next_retry_ms <= ? ORDER BY attempts, rowid LIMIT 1`)
      .get(Date.now()) as { itemId: string; attempts: number } | undefined;
    if (!next) {
      const earliest = db.prepare(`SELECT MIN(next_retry_ms) AS nextRetryMs FROM discovery_jobs WHERE status = 'pending'`)
        .get() as { nextRetryMs: number | null };
      if (earliest.nextRetryMs === null) db.prepare('UPDATE discovery_control SET active = 0 WHERE id = 1').run();
      else scheduleDiscovery(Math.max(1000, earliest.nextRetryMs - Date.now()));
      return;
    }
    db.prepare("UPDATE discovery_jobs SET status = 'running', attempts = attempts + 1 WHERE item_id = ?").run(next.itemId);
    try {
      const result = await searchCatalog(next.itemId);
      if (result.status === 'ready' || result.status === 'noCandidates') {
        db.prepare("UPDATE discovery_jobs SET status = 'completed' WHERE item_id = ?").run(next.itemId);
      } else if (result.status === 'accessDenied' || next.attempts >= 4) {
        db.prepare("UPDATE discovery_jobs SET status = 'failed' WHERE item_id = ?").run(next.itemId);
      } else {
        const rateLimit = db.prepare('SELECT next_allowed_ms AS nextAllowedMs FROM provider_state WHERE provider = ?')
          .get('apple') as { nextAllowedMs: number } | undefined;
        const delay = result.status === 'rateLimited' ? Math.max(1000, (rateLimit?.nextAllowedMs ?? 0) - Date.now())
          : Math.min(60000 * 2 ** next.attempts, 3600000);
        db.prepare("UPDATE discovery_jobs SET status = 'pending', next_retry_ms = ? WHERE item_id = ?")
          .run(Date.now() + delay, next.itemId);
      }
    } catch {
      const retry = next.attempts >= 4 ? 'failed' : 'pending';
      db.prepare('UPDATE discovery_jobs SET status = ?, next_retry_ms = ? WHERE item_id = ?')
        .run(retry, Date.now() + Math.min(60000 * 2 ** next.attempts, 3600000), next.itemId);
    }
  } finally {
    discoveryPumping = false;
    if ((db.prepare('SELECT active FROM discovery_control WHERE id = 1').get() as { active: number }).active && !discoveryTimer)
      scheduleDiscovery(0);
  }
}

function startDiscovery(batchId?: string | null): DiscoveryProgress {
  db.prepare(`UPDATE discovery_jobs SET status = 'pending', attempts = 0, next_retry_ms = 0
    WHERE status = 'failed' AND item_id IN (SELECT id FROM source_items ${batchId ? 'WHERE batch_id = ?' : ''})`)
    .run(...(batchId ? [batchId] : []));
  db.prepare(`INSERT OR IGNORE INTO discovery_jobs (item_id, status, attempts, next_retry_ms)
    SELECT i.id, 'pending', 0, 0 FROM source_items i
    LEFT JOIN file_matches f ON f.source_item_id = i.id
    LEFT JOIN catalog_searches c ON c.item_id = i.id
    WHERE f.source_item_id IS NULL AND (c.status IS NULL OR c.status NOT IN ('ready', 'noCandidates'))
    ${batchId ? 'AND i.batch_id = ?' : ''}`).run(...(batchId ? [batchId] : []));
  db.prepare('UPDATE discovery_control SET active = 1 WHERE id = 1').run();
  scheduleDiscovery();
  return getDiscoveryProgress();
}

function pauseDiscovery(): DiscoveryProgress {
  db.prepare('UPDATE discovery_control SET active = 0 WHERE id = 1').run();
  if (discoveryTimer) clearTimeout(discoveryTimer);
  discoveryTimer = null;
  return getDiscoveryProgress();
}

function getPurchasePlan(batchId?: string | null, losslessOnly = false, storePenaltyMinor = 0,
  maxBudgetMinor: number | null = null): PurchasePlanView {
  const items = getItems(batchId);
  const recordings = new Map<string, WantedRecording>();
  for (const item of items) {
    const key = sourceRecordingKey(item);
    const existing = recordings.get(key);
    if (existing) {
      existing.owned ||= !!item.matchedFileId;
      existing.purchased ||= item.purchaseStatus === 'userConfirmed';
    } else recordings.set(key, { id: key, label: `${item.artist} — ${item.title}`,
      owned: !!item.matchedFileId, purchased: item.purchaseStatus === 'userConfirmed' });
  }
  const candidateRows = db.prepare(`SELECT c.id, c.provider, c.provider_track_id AS providerTrackId,
    c.artist, c.title, c.price_minor AS priceMinor, c.currency, c.country, c.item_id AS itemId
    FROM catalog_candidates c JOIN source_items i ON i.id = c.item_id
    WHERE c.accepted = 1 ${batchId ? 'AND i.batch_id = ?' : ''}`)
    .all(...(batchId ? [batchId] : [])) as { id: string; provider: string; providerTrackId: string;
      artist: string; title: string; priceMinor: number | null; currency: string | null; country: string; itemId: string }[];
  const itemById = new Map(items.map(item => [item.id, item]));
  const offers = new Map<string, PurchaseOffer>();
  for (const row of candidateRows) {
    const item = itemById.get(row.itemId);
    if (!item) continue;
    const key = `${row.provider}:${row.providerTrackId}`;
    const coverage = sourceRecordingKey(item);
    const existing = offers.get(key);
    if (existing) {
      if (!existing.coverage.includes(coverage)) existing.coverage.push(coverage);
    } else offers.set(key, { id: key, candidateId: row.id, provider: row.provider,
      label: `${row.artist} — ${row.title}`, coverage: [coverage], priceMinor: row.priceMinor,
      currency: row.currency, country: row.country, quality: 'unknown', available: true, accepted: true });
  }
  const plan = planPurchases([...recordings.values()], [...offers.values()], {
    country: 'US', currency: 'USD', losslessOnly, storePenaltyMinor, maxBudgetMinor,
  });
  const label = (id: string) => ({ id, label: recordings.get(id)?.label ?? id });
  return { ...plan, uncovered: plan.uncovered.map(label), unknownCost: plan.unknownCost.map(label) };
}

if ((db.prepare('SELECT active FROM discovery_control WHERE id = 1').get() as { active: number }).active)
  scheduleDiscovery(1000);

parentPort.on('message', async (message: { id: number; type: 'preview' | 'import' | 'inventory' | 'errors' | 'deleteBatch' | 'export' | 'backup' | 'validateBackup' | 'scan' | 'scanCancel' | 'mediaZip' | 'files' | 'confirmFile' | 'confirmManualFile' | 'inventorySearch' | 'removeFile' | 'playlist' | 'organize' | 'undoCopy' | 'catalogSearch' | 'catalogGet' | 'catalogAccept' | 'catalogUrl' | 'catalogOpened' | 'purchaseConfirm' | 'purchaseUndo' | 'discoveryStart' | 'discoveryPause' | 'discoveryProgress' | 'purchasePlan'; filePath?: string; folder?: string; fileId?: string; itemId?: string; candidateId?: string; copyId?: string; query?: string; mapping?: ColumnMapping; expectedHash?: string; batchId?: string | null; collection?: string | null; format?: 'csv' | 'json'; offset?: number; limit?: number; losslessOnly?: boolean; storePenaltyMinor?: number; maxBudgetMinor?: number | null }) => {
  try {
    let result: unknown;
    switch (message.type) {
      case 'preview': result = await previewFile(message.filePath ?? ''); break;
      case 'import': result = await importFile(message.filePath ?? '', message.mapping, message.expectedHash); break;
      case 'inventory': result = getInventory(message.offset ?? 0, message.limit ?? 100, message.batchId, message.collection); break;
      case 'errors': result = getBatchErrors(message.batchId ?? ''); break;
      case 'deleteBatch': result = deleteBatch(message.batchId ?? ''); break;
      case 'export': result = await exportInventory(message.filePath ?? '', message.format ?? 'json', message.batchId); break;
      case 'backup': result = backupDatabase(message.filePath ?? ''); break;
      case 'validateBackup': result = validateBackup(message.filePath ?? ''); break;
      case 'scan': result = await scanFolder(message.folder ?? ''); break;
      case 'scanCancel': result = cancelScan(); break;
      case 'mediaZip': result = await ingestMediaZip(message.filePath ?? '', message.folder ?? ''); break;
      case 'files': result = getFiles(message.offset ?? 0, message.limit ?? 50); break;
      case 'confirmFile': result = await confirmFileMatch(message.fileId ?? '', message.itemId ?? ''); break;
      case 'confirmManualFile': result = await confirmFileMatch(message.fileId ?? '', message.itemId ?? '', true); break;
      case 'inventorySearch': result = searchInventory(message.query ?? ''); break;
      case 'removeFile': result = removeFileMatch(message.itemId ?? ''); break;
      case 'playlist': result = await exportPlaylist(message.filePath ?? '', message.batchId, message.collection); break;
      case 'organize': result = await organizeLinkedFiles(message.folder ?? ''); break;
      case 'undoCopy': result = await undoOrganizedCopy(message.copyId ?? ''); break;
      case 'catalogSearch': result = await searchCatalog(message.itemId ?? ''); break;
      case 'catalogGet': result = getCatalog(message.itemId ?? ''); break;
      case 'catalogAccept': result = acceptCatalogCandidate(message.itemId ?? '', message.candidateId ?? ''); break;
      case 'catalogUrl': result = storeCandidateUrl(message.candidateId ?? ''); break;
      case 'catalogOpened': result = setPurchaseStatus(message.candidateId ?? '', 'opened'); break;
      case 'purchaseConfirm': result = setPurchaseStatus(message.candidateId ?? '', 'userConfirmed'); break;
      case 'purchaseUndo': result = undoPurchaseConfirmation(message.candidateId ?? ''); break;
      case 'discoveryStart': result = startDiscovery(message.batchId); break;
      case 'discoveryPause': result = pauseDiscovery(); break;
      case 'discoveryProgress': result = getDiscoveryProgress(); break;
      case 'purchasePlan': result = getPurchasePlan(message.batchId, message.losslessOnly,
        message.storePenaltyMinor, message.maxBudgetMinor); break;
    }
    parentPort!.postMessage({ id: message.id, result });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});
