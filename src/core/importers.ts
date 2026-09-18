import { createHash, randomUUID } from 'node:crypto';
import type { ColumnField, ColumnMapping, ImportError, SourceItem } from '../shared/types';

export interface ParsedInventory {
  items: SourceItem[];
  errors: ImportError[];
  inputCount: number;
  duplicateCount: number;
  inputHash: string;
}

type Row = Record<string, unknown>;
const fields: ColumnField[] = ['artist', 'title', 'album', 'durationMs', 'isrc', 'sourceCollection'];
const aliases: Record<ColumnField, string[]> = {
  artist: ['artist', 'artist name', 'artistName', 'artists', 'album artist'],
  title: ['title', 'track name', 'trackName', 'track', 'song', 'name'],
  album: ['album', 'album name', 'albumName'],
  durationMs: ['duration ms', 'durationMs', 'duration_ms', 'duration (ms)'],
  isrc: ['isrc'],
  sourceCollection: ['playlist', 'playlist name', 'collection'],
};

function csvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(value); value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(value); value = '';
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
    } else value += char;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field.');
  row.push(value);
  if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function readCsv(content: string): { headers: string[]; rows: Row[] } {
  const data = csvRows(content.replace(/^\uFEFF/, ''));
  if (!data.length) throw new Error('The CSV file is empty.');
  const headers = data[0].map(cell => cell.trim());
  if (headers.some(header => !header)) throw new Error('CSV column names cannot be empty.');
  if (new Set(headers).size !== headers.length) throw new Error('CSV column names must be unique.');
  const tooWide = data.slice(1).findIndex(cells => cells.length > headers.length);
  if (tooWide >= 0) throw new Error(`CSV row ${tooWide + 1} has more values than column names.`);
  const rows = data.slice(1).map(cells => Object.fromEntries(headers.map((name, i) => [name, cells[i] ?? ''])));
  return { headers, rows };
}

export function previewCsv(content: string): Omit<import('../shared/types').CsvPreview, 'kind' | 'token' | 'fileName'> {
  const { headers, rows } = readCsv(content);
  const suggestedMapping: ColumnMapping = {};
  for (const field of fields) {
    suggestedMapping[field] = headers.find(header => aliases[field].some(alias => normalizeKey(header) === normalizeKey(alias)));
  }
  return { headers, sampleRows: rows.slice(0, 4) as Record<string, string>[], inputCount: rows.length,
    inputHash: createHash('sha256').update(content).digest('hex'), suggestedMapping };
}

function get(row: Row, names: string[]): unknown {
  const entries = Object.entries(row);
  for (const name of names) {
    const entry = entries.find(([key]) => normalizeKey(key) === normalizeKey(name));
    if (entry && entry[1] !== null && entry[1] !== '') return entry[1];
  }
  return undefined;
}

function asText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    const object = value as Row;
    return asText(object.name ?? object.title ?? object.artistName);
  }
  return '';
}

function duration(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function unwrap(row: Row): Row {
  const track = row.track;
  return track && typeof track === 'object' && !Array.isArray(track)
    ? { ...row, ...(track as Row) }
    : row;
}

export function parseInventory(content: string, extension: 'csv' | 'json', batchId: string = randomUUID(), mapping?: ColumnMapping): ParsedInventory {
  const inputHash = createHash('sha256').update(content).digest('hex');
  let rows: Row[];
  if (extension === 'csv') {
    const csv = readCsv(content);
    if (mapping) {
      if (!mapping.artist || !mapping.title) throw new Error('Choose columns for artist and title.');
      for (const field of fields) {
        const header = mapping[field];
        if (header !== undefined && !csv.headers.includes(header)) throw new Error(`Column ${header} is not in this CSV file.`);
      }
    }
    rows = csv.rows;
  } else {
    let root: unknown;
    try { root = JSON.parse(content.replace(/^\uFEFF/, '')); }
    catch { throw new Error('The JSON file could not be parsed.'); }
    const candidate = Array.isArray(root) ? root : root && typeof root === 'object'
      ? (root as Row).tracks ?? (root as Row).items ?? (root as Row).playlist
      : null;
    if (!Array.isArray(candidate)) throw new Error('JSON must be an array or contain a tracks/items array.');
    rows = candidate.map(value => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {});
  }

  const items: SourceItem[] = [];
  const errors: ImportError[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  rows.forEach((raw, index) => {
    const row = unwrap(raw);
    const value = (field: ColumnField) => mapping ? row[mapping[field] ?? ''] : get(row, aliases[field]);
    const artist = asText(value('artist'));
    const title = asText(value('title'));
    if (!artist || !title) {
      errors.push({ sourceOrder: index + 1, message: `Missing ${!artist ? 'artist' : 'title'}.`, originalValues: raw });
      return;
    }
    const album = asText(value('album')) || null;
    const isrc = asText(value('isrc')) || null;
    const sourceCollection = asText(value('sourceCollection')) || null;
    const key = [artist, title, album, isrc].map(x => x?.toLowerCase().normalize('NFKC')).join('\0');
    if (seen.has(key)) duplicateCount++;
    seen.add(key);
    items.push({ id: randomUUID(), batchId, sourceOrder: index + 1, artist, title, album,
      durationMs: duration(value('durationMs')), isrc, sourceCollection,
      originalValues: raw });
  });
  return { items, errors, inputCount: rows.length, duplicateCount, inputHash };
}
