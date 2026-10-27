import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { validateKeyring } from '../infra/encryption/crypto.js';
await mkdir('.local/encryption-secrets', { recursive: true });
for (const [name, content] of Object.entries({ 'keyring.json': JSON.stringify({ active: 'key-1', keys: { 'key-1': randomBytes(32).toString('hex') } }), 'service-token': randomBytes(48).toString('hex') })) {
  try { await writeFile(`.local/encryption-secrets/${name}`, content + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
validateKeyring(JSON.parse(await readFile('.local/encryption-secrets/keyring.json', 'utf8')));
if ((await readFile('.local/encryption-secrets/service-token', 'utf8')).trim().length < 32) throw Error('Invalid existing service token; not overwritten');
console.log('Platform encryption keyring and service token ready; existing secrets preserved.');
