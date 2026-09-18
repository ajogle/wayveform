import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared/types';

const api: DesktopApi = {
  prepareImport: () => ipcRenderer.invoke('inventory:prepare'),
  commitImport: (token, mapping) => ipcRenderer.invoke('inventory:commit', token, mapping),
  getInventory: (offset = 0, limit = 100, batchId = null, collection = null) => ipcRenderer.invoke('inventory:list', offset, limit, batchId, collection),
  getBatchErrors: batchId => ipcRenderer.invoke('inventory:errors', batchId),
  exportInventory: (format, batchId = null) => ipcRenderer.invoke('inventory:export', format, batchId),
  backupDatabase: () => ipcRenderer.invoke('database:backup'),
  restoreDatabase: () => ipcRenderer.invoke('database:restore'),
  deleteImport: batchId => ipcRenderer.invoke('inventory:delete', batchId),
  scanMusicFolder: () => ipcRenderer.invoke('files:scan'),
  importAudioZip: () => ipcRenderer.invoke('files:importZip'),
  cancelMusicScan: () => ipcRenderer.invoke('files:scanCancel'),
  onScanProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]) => callback(progress);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.removeListener('scan:progress', listener);
  },
  getFiles: (offset = 0, limit = 30) => ipcRenderer.invoke('files:list', offset, limit),
  confirmFileMatch: (fileId, itemId) => ipcRenderer.invoke('files:confirm', fileId, itemId),
  confirmManualFileMatch: (fileId, itemId) => ipcRenderer.invoke('files:confirmManual', fileId, itemId),
  searchInventory: query => ipcRenderer.invoke('inventory:search', query),
  removeFileMatch: itemId => ipcRenderer.invoke('files:remove', itemId),
  exportPlaylist: (batchId = null, collection = null) => ipcRenderer.invoke('playlist:export', batchId, collection),
  searchCatalog: itemId => ipcRenderer.invoke('catalog:search', itemId),
  getCatalog: itemId => ipcRenderer.invoke('catalog:get', itemId),
  acceptCatalogCandidate: (itemId, candidateId) => ipcRenderer.invoke('catalog:accept', itemId, candidateId),
  openStoreCandidate: candidateId => ipcRenderer.invoke('catalog:openStore', candidateId),
  startDiscovery: (batchId = null) => ipcRenderer.invoke('discovery:start', batchId),
  pauseDiscovery: () => ipcRenderer.invoke('discovery:pause'),
  getDiscoveryProgress: () => ipcRenderer.invoke('discovery:progress'),
  getPurchasePlan: (batchId = null, losslessOnly = false, storePenaltyMinor = 0, maxBudgetMinor = null) =>
    ipcRenderer.invoke('purchase:plan', batchId, losslessOnly, storePenaltyMinor, maxBudgetMinor),
  confirmPurchase: candidateId => ipcRenderer.invoke('purchase:confirm', candidateId),
  undoPurchaseConfirmation: candidateId => ipcRenderer.invoke('purchase:undo', candidateId),
  organizeLinkedFiles: () => ipcRenderer.invoke('files:organize'),
  undoOrganizedCopy: copyId => ipcRenderer.invoke('files:undoCopy', copyId),
};
contextBridge.exposeInMainWorld('wayveform', api);
