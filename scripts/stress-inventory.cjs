const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayveform-stress-'));
const source = path.join(dir, 'large.json');
const rows = Array.from({ length: 10000 }, (_, index) => ({
  artist: `Artist ${index % 100}`, title: `Song ${index % 1000}`, album: 'Album',
}));
fs.writeFileSync(source, JSON.stringify(rows));

async function workerCheck(check) {
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
  try { await check(call); }
  finally { await worker.terminate(); }
}

(async () => {
  let batchId;
  await workerCheck(async call => {
    const result = await call('import', { filePath: source });
    batchId = result.batch.id;
    assert.equal(result.batch.inputCount, 10000);
    assert.equal(result.batch.acceptedCount, 10000);
    assert.equal(result.batch.rejectedCount, 0);
    assert.equal(result.batch.duplicateCount, 9000);
  });
  await workerCheck(async call => {
    const page = await call('inventory', { offset: 9800, limit: 200, batchId });
    assert.equal(page.totalItems, 10000);
    assert.equal(page.items[0].sourceOrder, 9801);
    assert.equal(page.items.at(-1).sourceOrder, 10000);
    const plan = await call('purchasePlan', { batchId });
    assert.equal(plan.wantedCount, 1000);
  });
  console.log('10,000-row stress check passed: accounting, restart, paging, and deduplication.');
})().catch(error => { console.error(error); process.exitCode = 1; });
