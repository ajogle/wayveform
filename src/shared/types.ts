export interface SourceItem {
  id: string;
  batchId: string;
  sourceOrder: number;
  artist: string;
  title: string;
  album: string | null;
  durationMs: number | null;
  isrc: string | null;
  sourceCollection: string | null;
  originalValues: Record<string, unknown>;
  matchedFileId?: string | null;
  matchedFileName?: string | null;
  matchMethod?: 'tag_review' | 'manual' | null;
  catalogStatus?: CatalogStatus | null;
  catalogAccepted?: boolean;
  purchaseStatus?: 'opened' | 'userConfirmed' | null;
}

export interface FileAsset {
  id: string;
  fileName: string;
  folderName: string;
  sizeBytes: number;
  modifiedAtMs: number;
  sha256: string;
  format: string | null;
  durationMs: number | null;
  artist: string | null;
  title: string | null;
  album: string | null;
  scannedAt: string;
  matchCount: number;
  organizedCopyId?: string | null;
  organizedFileName?: string | null;
}

export interface FileSuggestion {
  itemId: string;
  artist: string;
  title: string;
  album: string | null;
  reason: string;
}

export interface ScannedFile extends FileAsset {
  suggestions: FileSuggestion[];
}

export interface FileInventory {
  files: ScannedFile[];
  totalFiles: number;
}

export interface ScanResult {
  scanned: number;
  skipped: number;
  failed: number;
  errors: string[];
  cancelled?: boolean;
}

export interface MediaIngestResult {
  folder: string;
  extracted: number;
  skipped: number;
  scan: ScanResult;
}

export interface OrganizeResult {
  copied: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface PlaylistExportResult {
  fileName: string;
  included: number;
  unresolved: number;
  unavailable: number;
}

export type CatalogStatus = 'notSearched' | 'ready' | 'noCandidates' | 'accessDenied' | 'rateLimited' | 'providerUnavailable';

export interface CatalogCandidate {
  id: string;
  itemId: string;
  provider: 'apple';
  providerTrackId: string;
  artist: string;
  title: string;
  album: string | null;
  durationMs: number | null;
  priceMinor: number | null;
  currency: string | null;
  country: string;
  storeUrl: string;
  matchLevel: 'strong' | 'review' | 'conflict';
  reason: string;
  accepted: boolean;
  purchaseStatus?: 'opened' | 'userConfirmed' | null;
}

export interface CatalogSearch {
  itemId: string;
  status: CatalogStatus;
  message: string | null;
  fetchedAt: string | null;
  candidates: CatalogCandidate[];
}

export interface DiscoveryProgress {
  active: boolean;
  queued: number;
  completed: number;
  failed: number;
  total: number;
  selected: number;
  needsReview: number;
  noResults: number;
}

export interface PurchasePlanView {
  selected: import('../core/purchase-planner').PurchaseOffer[];
  uncovered: { id: string; label: string }[];
  unknownCost: { id: string; label: string }[];
  estimatedSubtotalMinor: number;
  estimatedStorePenaltyMinor: number;
  estimatedTotalMinor: number;
  currency: string;
  wantedCount: number;
  ownedCount: number;
  purchasedAwaitingFileCount: number;
  coveredCount: number;
}

export interface ImportBatch {
  id: string;
  fileName: string;
  sourceType: 'csv' | 'json' | 'zip';
  importedAt: string;
  inputCount: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
}

export interface ImportError {
  sourceOrder: number;
  message: string;
  originalValues?: Record<string, unknown>;
}

export type ColumnField = 'artist' | 'title' | 'album' | 'durationMs' | 'isrc' | 'sourceCollection';
export type ColumnMapping = Partial<Record<ColumnField, string>>;

export interface CsvPreview {
  kind: 'csvPreview';
  token: string;
  fileName: string;
  headers: string[];
  sampleRows: Record<string, string>[];
  inputCount: number;
  inputHash: string;
  suggestedMapping: ColumnMapping;
}

export interface CompletedImport extends ImportResult {
  kind: 'imported';
}

export interface ImportResult {
  batch: ImportBatch;
  errors: ImportError[];
}

export interface InventorySnapshot {
  batches: ImportBatch[];
  collections: string[];
  items: SourceItem[];
  totalItems: number;
}

export interface DesktopApi {
  prepareImport(): Promise<CsvPreview | CompletedImport | null>;
  commitImport(token: string, mapping: ColumnMapping): Promise<ImportResult>;
  getInventory(offset?: number, limit?: number, batchId?: string | null, collection?: string | null): Promise<InventorySnapshot>;
  getBatchErrors(batchId: string): Promise<ImportError[]>;
  exportInventory(format: 'csv' | 'json', batchId?: string | null): Promise<string | null>;
  backupDatabase(): Promise<string | null>;
  restoreDatabase(): Promise<void>;
  deleteImport(batchId: string): Promise<boolean>;
  scanMusicFolder(): Promise<ScanResult | null>;
  importAudioZip(): Promise<MediaIngestResult | null>;
  cancelMusicScan(): Promise<void>;
  onScanProgress(callback: (progress: ScanResult) => void): () => void;
  getFiles(offset?: number, limit?: number): Promise<FileInventory>;
  confirmFileMatch(fileId: string, itemId: string): Promise<number>;
  searchInventory(query: string): Promise<FileSuggestion[]>;
  confirmManualFileMatch(fileId: string, itemId: string): Promise<number>;
  removeFileMatch(itemId: string): Promise<number>;
  exportPlaylist(batchId?: string | null, collection?: string | null): Promise<PlaylistExportResult | null>;
  searchCatalog(itemId: string): Promise<CatalogSearch>;
  getCatalog(itemId: string): Promise<CatalogSearch>;
  acceptCatalogCandidate(itemId: string, candidateId: string): Promise<void>;
  openStoreCandidate(candidateId: string): Promise<void>;
  startDiscovery(batchId?: string | null): Promise<DiscoveryProgress>;
  pauseDiscovery(): Promise<DiscoveryProgress>;
  getDiscoveryProgress(): Promise<DiscoveryProgress>;
  getPurchasePlan(batchId?: string | null, losslessOnly?: boolean, storePenaltyMinor?: number, maxBudgetMinor?: number | null): Promise<PurchasePlanView>;
  confirmPurchase(candidateId: string): Promise<void>;
  undoPurchaseConfirmation(candidateId: string): Promise<void>;
  organizeLinkedFiles(): Promise<OrganizeResult | null>;
  undoOrganizedCopy(copyId: string): Promise<void>;
}
