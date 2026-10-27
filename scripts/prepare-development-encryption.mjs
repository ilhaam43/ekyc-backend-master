import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export async function prepareDevelopmentEncryption() {
  const file = '.local/development-secrets/secure-transactions.key';
  await mkdir('.local/development-secrets', { recursive: true });
  try { await writeFile(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!/^[a-f0-9]{64}$/i.test((await readFile(file, 'utf8')).trim())) throw new Error('Existing development transaction key is invalid; it was not overwritten');
  return file;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { await prepareDevelopmentEncryption(); console.log('Development transaction secret is ready. Existing keys were preserved; no secret values were printed.'); }
