import { config, value } from '@ekyc/shared/config';
import { createDb } from '@ekyc/shared/db';
import { Storage } from '@ekyc/shared/storage';
import { listen } from '@ekyc/shared/http';
import { createApp } from './app.js';
import { drainOne } from '@ekyc/shared/outbox';
const cfg = config(); const db = createDb(cfg.databaseUrl); const storage = new Storage(cfg);
await storage.ensureBucket(cfg.documentBucket); await storage.ensureBucket(cfg.recordingBucket);
const app = createApp(db, cfg, storage);
let purging = false;
// Only explicit DELETE requests enqueue these jobs. Null retention never purges.
const purgeTimer = setInterval(async () => {
  if (purging) return;
  purging = true;
  try { await drainOne(db, { 'customer.purge': data => app.locals.deletion.process(data) }); }
  catch (error) { console.error(JSON.stringify({ level: 'error', code: error.code || 'PURGE_WORKER_FAILED' })); }
  finally { purging = false; }
}, 2000);
purgeTimer.unref();
listen(app, Number(value('PORT', '8080')), db);
