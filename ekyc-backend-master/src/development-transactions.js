import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { assert } from '@ekyc/shared/errors';
import { value } from '@ekyc/shared/config';

const format = 'development-only-aes-256-gcm-v1';
function localKey(cfg) {
  assert(cfg.encryptionMock && !cfg.production, 500, 'DEVELOPMENT_ENCRYPTION_FORBIDDEN');
  let raw;
  try { raw = value('DEVELOPMENT_TRANSACTION_KEY'); } catch { assert(false, 503, 'DEVELOPMENT_TRANSACTION_KEY_NOT_CONFIGURED'); }
  assert(typeof raw === 'string' && /^[a-f0-9]{64}$/i.test(raw), 503, 'DEVELOPMENT_TRANSACTION_KEY_NOT_CONFIGURED');
  return Buffer.from(raw, 'hex');
}
function context(row) { return Buffer.from(`development-secure-transaction:${row.tenant_id}:${row.id}:${new Date(row.expires_at).toISOString()}`); }
export function sealDevelopmentMaterial(cfg, row, material) {
  const key = localKey(cfg), nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(context(row));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(material), 'utf8'), cipher.final()]);
  return { format, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function openDevelopmentMaterial(cfg, row) {
  const key = localKey(cfg), envelope = row.encrypted_material;
  assert(envelope?.format === format, 422, 'INVALID_DEVELOPMENT_TRANSACTION');
  assert(new Date(row.expires_at).getTime() > Date.now(), 409, 'TRANSACTION_EXPIRED');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(context(row)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } catch { assert(false, 422, 'INVALID_DEVELOPMENT_TRANSACTION'); }
}
