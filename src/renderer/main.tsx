import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CatalogSearch, ColumnField, ColumnMapping, CsvPreview, DesktopApi, DiscoveryProgress, FileInventory, FileSuggestion, ImportError, ImportResult, InventorySnapshot, OrganizeResult, PurchasePlanView, ScanResult, SourceItem } from '../shared/types';
import './style.css';

declare global {
  interface Window { wayveform: DesktopApi }
}

const pageSize = 100;
const mappingFields: { key: ColumnField; label: string; required?: boolean }[] = [
  { key: 'artist', label: 'Artist', required: true },
  { key: 'title', label: 'Title', required: true },
  { key: 'album', label: 'Album' },
  { key: 'durationMs', label: 'Duration in milliseconds' },
  { key: 'isrc', label: 'ISRC' },
  { key: 'sourceCollection', label: 'Playlist or collection' },
];

function App() {
  const [snapshot, setSnapshot] = useState<InventorySnapshot | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState<ImportResult | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [batchErrors, setBatchErrors] = useState<ImportError[]>([]);
  const [notice, setNotice] = useState('');
  const [files, setFiles] = useState<FileInventory | null>(null);
  const [fileOffset, setFileOffset] = useState(0);
  const [fileSelections, setFileSelections] = useState<Record<string, string>>({});
  const [manualQueries, setManualQueries] = useState<Record<string, string>>({});
  const [manualResults, setManualResults] = useState<Record<string, FileSuggestion[]>>({});
  const [manualSelections, setManualSelections] = useState<Record<string, string>>({});
  const [scanReport, setScanReport] = useState<ScanResult | null>(null);
  const [scanActive, setScanActive] = useState(false);
  const [organizeReport, setOrganizeReport] = useState<OrganizeResult | null>(null);
  const [copyToUndo, setCopyToUndo] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogSearch | null>(null);
  const [catalogItem, setCatalogItem] = useState<SourceItem | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryProgress | null>(null);
  const [purchasePlan, setPurchasePlan] = useState<PurchasePlanView | null>(null);
  const [losslessOnly, setLosslessOnly] = useState(false);
  const [storePenalty, setStorePenalty] = useState('0');
  const [budget, setBudget] = useState('');

  async function refresh(pageOffset = offset, batchId = selectedBatch, collection = selectedCollection) {
    try {
      setSnapshot(await window.wayveform.getInventory(pageOffset, pageSize, batchId, collection));
      setOffset(pageOffset);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open the local inventory.');
    }
  }

  async function refreshFiles(pageOffset = fileOffset) {
    try {
      setFiles(await window.wayveform.getFiles(pageOffset, 30));
      setFileOffset(pageOffset);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load scanned files.'); }
  }

  useEffect(() => {
    void refresh(0);
    void refreshFiles(0);
    void window.wayveform.getDiscoveryProgress().then(setDiscovery);
    return window.wayveform.onScanProgress(setScanReport);
  }, []);

  useEffect(() => {
    if (!discovery?.active) return;
    const timer = window.setInterval(async () => {
      try {
        const progress = await window.wayveform.getDiscoveryProgress();
        setDiscovery(progress);
        await refresh(offset, selectedBatch);
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update discovery progress.'); }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [discovery?.active, offset, selectedBatch]);

  async function importFile() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.wayveform.prepareImport();
      if (result?.kind === 'csvPreview') {
        setPreview(result);
        setMapping(result.suggestedMapping);
      } else if (result?.kind === 'imported') {
        await finishImport(result);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The import failed.');
    } finally { setBusy(false); }
  }

  async function finishImport(result: ImportResult) {
    setRecent(result);
    setPreview(null);
    setSelectedBatch(result.batch.id);
    setSelectedCollection(null);
    setBatchErrors(result.errors);
    await refresh(0, result.batch.id, null);
  }

  async function commitImport() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try { await finishImport(await window.wayveform.commitImport(preview.token, mapping)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The import failed.'); }
    finally { setBusy(false); }
  }

  async function chooseBatch(batchId: string | null) {
    setSelectedBatch(batchId);
    setSelectedCollection(null);
    setPurchasePlan(null);
    setBatchErrors(batchId ? await window.wayveform.getBatchErrors(batchId) : []);
    await refresh(0, batchId, null);
  }

  async function chooseCollection(collection: string | null) {
    setSelectedCollection(collection);
    await refresh(0, selectedBatch, collection);
  }

  async function deleteSelectedImport() {
    if (!selectedBatch) return;
    setBusy(true);
    setError('');
    try {
      if (await window.wayveform.deleteImport(selectedBatch)) {
        setSelectedBatch(null);
        setSelectedCollection(null);
        setBatchErrors([]);
        setRecent(null);
        setCatalog(null);
        setCatalogItem(null);
        setPurchasePlan(null);
        setNotice('Imported list removed from the local database.');
        await refresh(0, null, null);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete the import.'); }
    finally { setBusy(false); }
  }

  async function exportFile(format: 'csv' | 'json') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const fileName = await window.wayveform.exportInventory(format, selectedBatch);
      if (fileName) setNotice(`Saved ${fileName}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Export failed.'); }
    finally { setBusy(false); }
  }

  async function backupDatabase() {
    setBusy(true);
    setError('');
    try {
      const fileName = await window.wayveform.backupDatabase();
      if (fileName) setNotice(`Saved full library backup as ${fileName}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the backup.'); }
    finally { setBusy(false); }
  }

  async function restoreDatabase() {
    setBusy(true);
    setError('');
    try { await window.wayveform.restoreDatabase(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore the backup.'); }
    finally { setBusy(false); }
  }

  async function scanMusic() {
    setBusy(true);
    setScanActive(true);
    setScanReport(null);
    setError('');
    setNotice('');
    try {
      const report = await window.wayveform.scanMusicFolder();
      if (report) { setScanReport(report); await refreshFiles(0); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Folder scan failed.'); }
    finally { setBusy(false); setScanActive(false); }
  }

  async function importAudioZip() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.wayveform.importAudioZip();
      if (result) {
        setScanReport(result.scan);
        setNotice(`${result.extracted} audio files extracted to ${result.folder}. The original ZIP was kept.`);
        await refreshFiles(0);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not import audio ZIP.'); }
    finally { setBusy(false); }
  }

  async function organizeFiles() {
    setBusy(true);
    setError('');
    try {
      const report = await window.wayveform.organizeLinkedFiles();
      if (report) {
        setOrganizeReport(report);
        setNotice(`${report.copied} linked files copied to the selected library folder. Originals were kept.`);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not organize files.'); }
    finally { setBusy(false); }
  }

  async function undoCopy(copyId: string) {
    setBusy(true);
    setError('');
    try {
      await window.wayveform.undoOrganizedCopy(copyId);
      setCopyToUndo(null);
      setNotice('Organized copy removed. The original file remains untouched.');
      await refreshFiles(fileOffset);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not undo copy.'); }
    finally { setBusy(false); }
  }

  async function confirmMatch(fileId: string) {
    const itemId = fileSelections[fileId] || files?.files.find(file => file.id === fileId)?.suggestions[0]?.itemId;
    if (!itemId) return;
    setBusy(true);
    setError('');
    try {
      const count = await window.wayveform.confirmFileMatch(fileId, itemId);
      setPurchasePlan(null);
      setNotice(`Linked the file to ${count} matching track ${count === 1 ? 'occurrence' : 'occurrences'}.`);
      await Promise.all([refreshFiles(fileOffset), refresh(offset, selectedBatch)]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not link file.'); }
    finally { setBusy(false); }
  }

  async function searchManualMatches(fileId: string) {
    setError('');
    try {
      const results = await window.wayveform.searchInventory(manualQueries[fileId] ?? '');
      setManualResults({ ...manualResults, [fileId]: results });
      if (results.length) setManualSelections({ ...manualSelections, [fileId]: results[0].itemId });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not search inventory.'); }
  }

  async function confirmManualMatch(fileId: string) {
    const itemId = manualSelections[fileId];
    if (!itemId) return;
    setBusy(true);
    setError('');
    try {
      const count = await window.wayveform.confirmManualFileMatch(fileId, itemId);
      setNotice(`Manually linked ${count} track ${count === 1 ? 'occurrence' : 'occurrences'}.`);
      setPurchasePlan(null);
      await Promise.all([refreshFiles(fileOffset), refresh(offset, selectedBatch)]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not link file manually.'); }
    finally { setBusy(false); }
  }

  async function removeMatch(itemId: string) {
    setBusy(true);
    setError('');
    try {
      const count = await window.wayveform.removeFileMatch(itemId);
      setPurchasePlan(null);
      setNotice(`Removed ${count} file ${count === 1 ? 'link' : 'links'}.`);
      await Promise.all([refreshFiles(fileOffset), refresh(offset, selectedBatch)]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove file link.'); }
    finally { setBusy(false); }
  }

  async function exportPlaylist() {
    setBusy(true);
    setError('');
    try {
      const result = await window.wayveform.exportPlaylist(selectedBatch, selectedCollection);
      if (result) setNotice(`Saved ${result.fileName}: ${result.included} playable entries, ${result.unresolved} without a linked file, ${result.unavailable} unavailable files.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Playlist export failed.'); }
    finally { setBusy(false); }
  }

  async function reviewCatalog(item: SourceItem) {
    setCatalogItem(item);
    setError('');
    try { setCatalog(await window.wayveform.getCatalog(item.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load catalog matches.'); }
  }

  async function searchCatalog() {
    if (!catalogItem) return;
    setBusy(true);
    setError('');
    try { setCatalog(await window.wayveform.searchCatalog(catalogItem.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Catalog search failed.'); }
    finally { setBusy(false); }
  }

  async function acceptCatalogCandidate(candidateId: string) {
    if (!catalogItem) return;
    setBusy(true);
    setError('');
    try {
      await window.wayveform.acceptCatalogCandidate(catalogItem.id, candidateId);
      setPurchasePlan(null);
      setCatalog(await window.wayveform.getCatalog(catalogItem.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not accept recording.'); }
    finally { setBusy(false); }
  }

  async function openStore(candidateId: string) {
    setError('');
    try {
      await window.wayveform.openStoreCandidate(candidateId);
      if (catalogItem) setCatalog(await window.wayveform.getCatalog(catalogItem.id));
      await refresh(offset, selectedBatch);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open store.'); }
  }

  async function confirmPurchase(candidateId: string, undo = false) {
    setBusy(true);
    setError('');
    try {
      if (undo) await window.wayveform.undoPurchaseConfirmation(candidateId);
      else await window.wayveform.confirmPurchase(candidateId);
      setPurchasePlan(null);
      if (catalogItem) setCatalog(await window.wayveform.getCatalog(catalogItem.id));
      await refresh(offset, selectedBatch);
      setNotice(undo ? 'Purchase confirmation removed.' : 'Purchase marked as user-confirmed. Link the downloaded file separately.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update purchase state.'); }
    finally { setBusy(false); }
  }

  async function startDiscovery() {
    setError('');
    try { setDiscovery(await window.wayveform.startDiscovery(selectedBatch)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start discovery.'); }
  }

  async function pauseDiscovery() {
    setError('');
    try { setDiscovery(await window.wayveform.pauseDiscovery()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not pause discovery.'); }
  }

  async function buildPurchasePlan() {
    setError('');
    const penalty = Number(storePenalty);
    const maximum = budget.trim() ? Number(budget) : null;
    if (!Number.isFinite(penalty) || penalty < 0 || (maximum !== null && (!Number.isFinite(maximum) || maximum < 0))) {
      setError('Use nonnegative amounts for store cost and budget.');
      return;
    }
    try {
      setPurchasePlan(await window.wayveform.getPurchasePlan(selectedBatch, losslessOnly,
        Math.round(penalty * 100), maximum === null ? null : Math.round(maximum * 100)));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not build buying plan.'); }
  }

  const currentBatch = snapshot?.batches.find(batch => batch.id === selectedBatch);

  return <main>
    <header className="topbar">
      <div className="brand"><span className="brandmark">◉</span> Wayveform <span className="tag">LOCAL LIBRARY</span></div>
      <span className="status"><span className="status-dot" /> Your inventory stays on this computer</span>
    </header>
    <section className="hero">
      <p className="eyebrow">START WITH WHAT YOU LOVE</p>
      <h1>Your music, on your terms.</h1>
      <p>Bring in a list of songs to start building a collection of files you own.</p>
      <button className="primary" onClick={importFile} disabled={busy}>{busy ? 'Importing…' : 'Import music list'}</button>
      <p className="hint">Choose CSV, JSON, or a Spotify account-data ZIP. ZIP import reads only library and playlist JSON files.</p>
    </section>
    {error && <div className="alert" role="alert">{error}</div>}
    {notice && <div className="import-report" role="status">{notice}</div>}
    {preview && <section className="mapping-panel" aria-label="Map CSV columns">
      <div className="section-heading"><div><p className="eyebrow">REVIEW IMPORT</p><h2>Match your columns</h2></div><span className="count">{preview.inputCount} rows in {preview.fileName}</span></div>
      <p className="batch-count">Choose which CSV columns contain each field. Artist and title are required.</p>
      <div className="mapping-grid">{mappingFields.map(field => <label key={field.key}>
        <span>{field.label}{field.required ? ' *' : ''}</span>
        <select value={mapping[field.key] ?? ''} onChange={event => setMapping({ ...mapping, [field.key]: event.target.value || undefined })}>
          <option value="">{field.required ? 'Choose a column' : 'Not present'}</option>
          {preview.headers.map(header => <option key={header} value={header}>{header}</option>)}
        </select>
      </label>)}</div>
      <div className="sample"><strong>First rows</strong><div className="table-wrap"><table><thead><tr>{preview.headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{preview.sampleRows.map((row, index) => <tr key={index}>{preview.headers.map(header => <td key={header}>{row[header]}</td>)}</tr>)}</tbody></table></div></div>
      <div className="actions"><button className="secondary" onClick={() => setPreview(null)}>Cancel</button><button className="primary" onClick={commitImport} disabled={busy || !mapping.artist || !mapping.title}>{busy ? 'Importing…' : 'Import tracks'}</button></div>
    </section>}
    {recent && <section className="import-report" aria-label="Import report">
      <div><strong>{recent.batch.fileName}</strong> imported</div>
      <p>{recent.batch.acceptedCount} accepted · {recent.batch.rejectedCount} rejected · {recent.batch.duplicateCount} repeated songs retained</p>
    </section>}
    <section className="library">
      <div className="section-heading"><div><p className="eyebrow">INVENTORY</p><h2>Your tracks</h2></div><span className="count">{snapshot?.totalItems ?? 0} occurrences</span></div>
      <div className="export-actions"><button className="secondary" disabled={busy} onClick={() => void backupDatabase()}>Back up library</button><button className="secondary" disabled={busy} onClick={() => void restoreDatabase()}>Restore backup</button></div>
      {snapshot && snapshot.batches.length > 0 && <>
        <p className="batch-count">Repeated playlist entries remain in source order.</p>
        <div className="toolbar"><label>Show <select value={selectedBatch ?? ''} onChange={event => void chooseBatch(event.target.value || null)}><option value="">All imports</option>{snapshot.batches.map(batch => <option key={batch.id} value={batch.id}>{batch.fileName} · {new Date(batch.importedAt).toLocaleString()}</option>)}</select></label>
          <label>Collection <select value={selectedCollection ?? ''} onChange={event => void chooseCollection(event.target.value || null)}><option value="">All collections</option>{snapshot.collections.map(collection => <option key={collection} value={collection}>{collection}</option>)}</select></label>
          {selectedBatch && <button className="secondary" disabled={busy} onClick={() => void deleteSelectedImport()}>Delete selected import</button>}
          <div className="export-actions"><button className="secondary" disabled={busy} onClick={() => void exportFile('csv')}>Export CSV</button><button className="secondary" disabled={busy} onClick={() => void exportFile('json')}>Export JSON</button><button className="secondary" disabled={busy} onClick={() => void exportPlaylist()}>Export M3U8</button></div>
        </div>
        <div className="discovery-panel"><div><strong>Find catalog recordings</strong><p>Apple receives artist and title queries for tracks without linked files. Searches run at a conservative pace and resume after restart. Store prices are observations, not verified download offers.</p>{discovery && discovery.total > 0 && <span>{discovery.completed} completed · {discovery.queued} queued · {discovery.failed} need attention</span>}</div><button className="secondary" onClick={() => void (discovery?.active ? pauseDiscovery() : startDiscovery())}>{discovery?.active ? 'Pause searches' : discovery?.queued ? 'Resume searches' : 'Find missing tracks'}</button></div>
        {currentBatch && <div className="batch-summary">{currentBatch.inputCount} input rows · {currentBatch.acceptedCount} accepted · {currentBatch.rejectedCount} rejected · {currentBatch.duplicateCount} repeated songs
          {batchErrors.length > 0 && <details><summary>Review {batchErrors.length} rejected rows</summary><ul>{batchErrors.map((item, index) => <li key={index}>Row {item.sourceOrder}: {item.message}</li>)}</ul></details>}
        </div>}
      </>}
      {snapshot?.items.length ? <>
        <div className="table-wrap"><table><thead><tr><th>Track</th><th>Artist</th><th>Album</th><th>Source</th><th>Purchase</th><th>Local file</th><th>Catalog</th></tr></thead><tbody>
          {snapshot.items.map(item => <tr key={item.id}><td className="track-title">{item.title}</td><td>{item.artist}</td><td>{item.album || <span className="muted">—</span>}</td><td>{item.sourceCollection || <span className="muted">Imported list</span>}</td><td>{item.purchaseStatus === 'userConfirmed' ? <span className="matched">User confirmed</span> : item.purchaseStatus === 'opened' ? 'Store opened' : <span className="muted">None recorded</span>}</td><td>{item.matchedFileId ? <div className="linked-file"><span>{item.matchedFileName}{item.matchMethod === 'manual' ? ' (manual)' : ''}</span><button disabled={busy} onClick={() => void removeMatch(item.id)}>Unlink</button></div> : <span className="muted">Not linked</span>}</td><td><button className="table-action" onClick={() => void reviewCatalog(item)}>{item.catalogStatus === 'ready' ? 'Review results' : item.catalogStatus === 'noCandidates' ? 'No results' : item.catalogStatus && item.catalogStatus !== 'notSearched' ? 'Retry search' : 'Search'}</button></td></tr>)}
        </tbody></table></div>
        <div className="pagination"><button disabled={offset === 0} onClick={() => void refresh(Math.max(0, offset - pageSize))}>Previous</button><span>{offset + 1}–{Math.min(offset + pageSize, snapshot.totalItems)} of {snapshot.totalItems}</span><button disabled={offset + pageSize >= snapshot.totalItems} onClick={() => void refresh(offset + pageSize)}>Next</button></div>
      </> : <div className="empty"><div className="empty-icon">♫</div><strong>No tracks yet</strong><p>Import a music list to see it here.</p></div>}
    </section>
    {catalogItem && catalog && <section className="library catalog-section" aria-label="Catalog review">
      <div className="section-heading"><div><p className="eyebrow">RECORDING DISCOVERY</p><h2>{catalogItem.artist} — {catalogItem.title}</h2></div><button className="secondary" onClick={() => { setCatalogItem(null); setCatalog(null); }}>Close</button></div>
      <p className="batch-count">Searching sends this artist and title to Apple’s catalog. Results are suggestions, and a listed price does not verify file format, checkout, or delivery.</p>
      <button className="primary" disabled={busy} onClick={() => void searchCatalog()}>{busy ? 'Searching…' : catalog.status === 'notSearched' ? 'Search Apple catalog' : 'Refresh Apple results'}</button>
      {catalog.fetchedAt && <span className="catalog-time">Last searched {new Date(catalog.fetchedAt).toLocaleString()}</span>}
      {catalog.message && <p className="catalog-message">{catalog.message}</p>}
      {catalog.status === 'noCandidates' && <p className="catalog-message">No catalog candidates were returned for this search.</p>}
      {catalog.candidates.length > 0 && <div className="candidate-list">{catalog.candidates.map(candidate => <div className="candidate" key={candidate.id}>
        <div><strong>{candidate.artist} — {candidate.title}</strong><p>{candidate.album || 'Album unknown'} · {candidate.durationMs ? `${Math.round(candidate.durationMs / 1000)} sec` : 'Duration unknown'}</p><span className={`match-level ${candidate.matchLevel}`}>{candidate.matchLevel === 'conflict' ? 'Conflict' : candidate.matchLevel === 'strong' ? 'Strong suggestion' : 'Needs review'}</span><p>{candidate.reason}</p></div>
        <div className="candidate-actions"><strong>{candidate.priceMinor !== null && candidate.currency === 'USD' ? `$${(candidate.priceMinor / 100).toFixed(2)}` : 'Price unknown'}</strong><span>US store · format unverified</span>{candidate.accepted ? <><span className="matched">Accepted match</span><button className="secondary" onClick={() => void openStore(candidate.id)}>Open store</button>{candidate.purchaseStatus === 'userConfirmed' ? <><span className="matched">User-confirmed purchase</span><button className="table-action" disabled={busy} onClick={() => void confirmPurchase(candidate.id, true)}>Undo confirmation</button></> : <button className="secondary" disabled={busy} onClick={() => void confirmPurchase(candidate.id)}>I purchased this</button>}</> : <button className="secondary" disabled={busy} onClick={() => void acceptCatalogCandidate(candidate.id)}>{candidate.matchLevel === 'conflict' ? 'Accept despite conflict' : 'Accept recording'}</button>}</div>
      </div>)}</div>}
    </section>}
    <section className="library planning-section">
      <div className="section-heading"><div><p className="eyebrow">BUYING STRATEGY</p><h2>Plan purchases</h2></div></div>
      <p className="batch-count">Compare accepted US quotes for recordings still missing a linked local file. This is a best-found plan among reviewed offers, before taxes. Apple file format and delivery are unverified.</p>
      <div className="plan-controls"><label className="checkbox"><input type="checkbox" checked={losslessOnly} onChange={event => setLosslessOnly(event.target.checked)} /> Lossless only</label><label>Store cost preference ($)<input type="number" min="0" step="0.01" value={storePenalty} onChange={event => setStorePenalty(event.target.value)} /></label><label>Maximum budget ($, optional)<input type="number" min="0" step="0.01" value={budget} onChange={event => setBudget(event.target.value)} /></label><button className="primary" onClick={() => void buildPurchasePlan()}>Build plan</button></div>
      {purchasePlan && <div className="plan-result"><div className="plan-metrics"><span>{purchasePlan.ownedCount} already local</span><span>{purchasePlan.purchasedAwaitingFileCount} purchased, awaiting file</span><span>{purchasePlan.coveredCount} covered by quotes</span><span>{purchasePlan.unknownCost.length} unknown cost</span><span>{purchasePlan.uncovered.length} uncovered</span></div>
        <div className="plan-total">Estimated subtotal: <strong>${(purchasePlan.estimatedSubtotalMinor / 100).toFixed(2)}</strong>{purchasePlan.estimatedStorePenaltyMinor > 0 && <span> · Store preference cost: ${(purchasePlan.estimatedStorePenaltyMinor / 100).toFixed(2)}</span>}</div>
        {purchasePlan.selected.length > 0 && <div className="plan-offers">{purchasePlan.selected.map(offer => <div key={offer.id}><span>{offer.label} · {offer.provider} · {offer.coverage.length} recording{offer.coverage.length === 1 ? '' : 's'}</span><strong>${(offer.priceMinor! / 100).toFixed(2)}</strong><button className="secondary" onClick={() => void openStore(offer.candidateId)}>Open store</button></div>)}</div>}
        {purchasePlan.unknownCost.length > 0 && <details><summary>Unknown cost</summary><ul>{purchasePlan.unknownCost.map(item => <li key={item.id}>{item.label}</li>)}</ul></details>}
        {purchasePlan.uncovered.length > 0 && <details><summary>Uncovered recordings</summary><ul>{purchasePlan.uncovered.map(item => <li key={item.id}>{item.label}</li>)}</ul></details>}
      </div>}
    </section>
    <section className="library files-section">
      <div className="section-heading"><div><p className="eyebrow">FILES YOU ALREADY HAVE</p><h2>Local music</h2></div><span className="count">{files?.totalFiles ?? 0} inspected files</span></div>
      <p className="batch-count">Choose a folder to scan, or import a downloaded audio ZIP. Wayveform reads audio tags and hashes files; it leaves originals in place. Review suggested links before they count toward a playlist.</p>
      <div className="export-actions"><button className="primary" disabled={busy} onClick={() => void scanMusic()}>{scanActive ? 'Scanning…' : 'Scan a music folder'}</button>{scanActive && <button className="secondary" onClick={() => void window.wayveform.cancelMusicScan()}>Stop scan</button>}<button className="secondary" disabled={busy} onClick={() => void importAudioZip()}>Import audio ZIP</button><button className="secondary" disabled={busy || !files?.totalFiles} onClick={() => void organizeFiles()}>Copy linked files to library</button></div>
      {scanReport && <div className="batch-summary scan-report" role="status">{scanReport.scanned} inspected · {scanReport.skipped} unchanged or skipped · {scanReport.failed} failed{scanReport.cancelled ? ' · Stopped' : ''}
        {scanReport.errors.length > 0 && <details><summary>Review scan issues</summary><ul>{scanReport.errors.map((message, index) => <li key={index}>{message}</li>)}</ul></details>}
      </div>}
      {organizeReport && <div className="batch-summary scan-report">{organizeReport.copied} copied · {organizeReport.skipped} already organized · {organizeReport.failed} failed
        {organizeReport.errors.length > 0 && <details><summary>Review copy issues</summary><ul>{organizeReport.errors.map((message, index) => <li key={index}>{message}</li>)}</ul></details>}
      </div>}
      {files?.files.length ? <>
        <div className="file-list">{files.files.map(file => <div className="file-card" key={file.id}>
          <div className="file-info"><strong>{file.fileName}</strong><span>{file.folderName} · {file.format || 'Unknown format'} · {Math.round(file.sizeBytes / 1024 / 1024)} MB</span>
            <span>{file.artist && file.title ? `${file.artist} — ${file.title}` : 'Artist or title tags missing'}</span>{file.matchCount > 0 && <span className="matched">Linked to {file.matchCount} track occurrences</span>}{file.organizedCopyId && <span className="matched">Organized copy: {file.organizedFileName} {copyToUndo === file.organizedCopyId ? <><button className="table-action" disabled={busy} onClick={() => void undoCopy(file.organizedCopyId!)}>Confirm remove copy</button><button className="table-action" onClick={() => setCopyToUndo(null)}>Cancel</button></> : <button className="table-action" onClick={() => setCopyToUndo(file.organizedCopyId!)}>Undo copy</button>}</span>}</div>
          {file.suggestions.length > 0 ? <div className="file-review"><label>Suggested match<select value={fileSelections[file.id] ?? file.suggestions[0].itemId} onChange={event => setFileSelections({ ...fileSelections, [file.id]: event.target.value })}>{file.suggestions.map(suggestion => <option key={suggestion.itemId} value={suggestion.itemId}>{suggestion.artist} — {suggestion.title}{suggestion.album ? ` · ${suggestion.album}` : ''}</option>)}</select></label><p>{file.suggestions.find(suggestion => suggestion.itemId === (fileSelections[file.id] ?? file.suggestions[0].itemId))?.reason}</p><button className="secondary" disabled={busy} onClick={() => void confirmMatch(file.id)}>Confirm link</button></div>
            : <div className="file-review muted">{file.matchCount ? 'No other likely matches' : 'No tag-based match found'}</div>}
          <div className="manual-review"><label>Find a track to link manually<input type="search" value={manualQueries[file.id] ?? ''} onChange={event => setManualQueries({ ...manualQueries, [file.id]: event.target.value })} placeholder="Artist or title" /></label><button className="secondary" onClick={() => void searchManualMatches(file.id)}>Search inventory</button>
            {manualResults[file.id] && (manualResults[file.id].length ? <><select aria-label="Manual track match" value={manualSelections[file.id] ?? manualResults[file.id][0].itemId} onChange={event => setManualSelections({ ...manualSelections, [file.id]: event.target.value })}>{manualResults[file.id].map(choice => <option key={choice.itemId} value={choice.itemId}>{choice.artist} — {choice.title}{choice.album ? ` · ${choice.album}` : ''}</option>)}</select><button className="secondary" disabled={busy} onClick={() => void confirmManualMatch(file.id)}>Confirm manual link</button></> : <span className="muted">No matching inventory tracks</span>)}<p>Manual links bypass tag matching. Check the recording yourself.</p></div>
        </div>)}</div>
        <div className="pagination"><button disabled={fileOffset === 0} onClick={() => void refreshFiles(Math.max(0, fileOffset - 30))}>Previous</button><span>{fileOffset + 1}–{Math.min(fileOffset + 30, files.totalFiles)} of {files.totalFiles}</span><button disabled={fileOffset + 30 >= files.totalFiles} onClick={() => void refreshFiles(fileOffset + 30)}>Next</button></div>
      </> : <div className="empty"><div className="empty-icon">◈</div><strong>No files scanned</strong><p>Pick a folder containing music you already own.</p></div>}
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
