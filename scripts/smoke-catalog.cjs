const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayveform-catalog-'));
const source = path.join(dir, 'tracks.json');
fs.writeFileSync(source, JSON.stringify([
  { artist: 'Jack Johnson', title: 'Upside Down' },
  { artist: 'Jack Johnson', title: 'Upside Down' },
]));
const worker = new Worker(path.resolve('dist/electron/worker.js'), {
  workerData: { databasePath: path.join(dir, 'inventory.sqlite') },
});
let id = 0;
function call(type, details = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    function onMessage(message) {
      if (message.id !== requestId) return;
      worker.off('message', onMessage);
      if (message.error) reject(new Error(message.error)); else resolve(message.result);
    }
    worker.on('message', onMessage);
    worker.postMessage({ id: requestId, type, ...details });
  });
}

(async () => {
  await call('import', { filePath: source });
  const inventory = await call('inventory', { offset: 0, limit: 10 });
  const itemId = inventory.items[0].id;
  await call('discoveryStart');
  let progress;
  for (let attempt = 0; attempt < 30; attempt++) {
    progress = await call('discoveryProgress');
    if (progress.completed === 2) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(progress.completed, 2);
  const result = await call('catalogGet', { itemId });
  assert.equal(result.status, 'ready');
  assert.ok(result.candidates.length > 0);
  const accepted = result.candidates.find(candidate => candidate.matchLevel === 'strong');
  assert.ok(accepted);
  await call('catalogAccept', { itemId, candidateId: accepted.id });
  const plan = await call('purchasePlan');
  assert.equal(plan.wantedCount, 1);
  assert.equal(plan.selected.length, 1);
  assert.equal(plan.estimatedSubtotalMinor, accepted.priceMinor);
  const url = await call('catalogUrl', { candidateId: accepted.id });
  assert.ok(url.startsWith('https://music.apple.com/') || url.startsWith('https://itunes.apple.com/'));
  await call('catalogOpened', { candidateId: accepted.id });
  assert.equal((await call('catalogGet', { itemId })).candidates.find(x => x.id === accepted.id).purchaseStatus, 'opened');
  await call('purchaseConfirm', { candidateId: accepted.id });
  const purchasedPlan = await call('purchasePlan');
  assert.equal(purchasedPlan.purchasedAwaitingFileCount, 1);
  assert.equal(purchasedPlan.selected.length, 0);
  await call('purchaseUndo', { candidateId: accepted.id });
  assert.equal((await call('purchasePlan')).selected.length, 1);
  console.log('Live catalog smoke check passed: background queue, buying plan, and separate purchase status.');
  await worker.terminate();
})().catch(async error => {
  console.error(error);
  await worker.terminate();
  process.exitCode = 1;
});
