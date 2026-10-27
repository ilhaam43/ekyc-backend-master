import { readFileSync } from 'node:fs';
import { required } from '../../packages/shared/src/config.js';
import { encryptionApp } from './app.js';

let app;
try {
  const ring = JSON.parse(readFileSync(required('PLATFORM_ENCRYPTION_KEYRING_FILE'), 'utf8'));
  app = encryptionApp(ring, required('PLATFORM_ENCRYPTION_TOKEN'));
} catch {
  console.error(JSON.stringify({ event: 'platform_encryption_startup_failed', code: 'INVALID_ENCRYPTION_CONFIGURATION' }));
  process.exit(1);
}
const server = app.listen(8090, '0.0.0.0', () => console.log(JSON.stringify({ event: 'platform_encryption_ready', port: 8090 })));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); });
