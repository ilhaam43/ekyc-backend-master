import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { assert } from '../../packages/shared/src/errors.js';
import { platformFormat } from '../../packages/shared/src/platform-crypto.js';

export function validateKeyring(ring) {
  assert(ring && typeof ring.active === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(ring.active) && ring.keys && typeof ring.keys === 'object' && !Array.isArray(ring.keys) && Object.hasOwn(ring.keys, ring.active) && Object.keys(ring.keys).length <= 32, 500, 'INVALID_ENCRYPTION_KEYRING');
  for (const [id, key] of Object.entries(ring.keys)) assert(/^[a-zA-Z0-9_-]{1,64}$/.test(id) && typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key), 500, 'INVALID_ENCRYPTION_KEYRING');
  return ring;
}
export function crypt(ring, operation, input) {
  const { tenant_id: tenant, purpose, resource_id: resource, data } = input || {};
  assert(typeof tenant === 'string' && /^[a-f0-9-]{36}$/i.test(tenant) && ['customer-profile', 'secure-transaction'].includes(purpose) && typeof resource === 'string' && /^[a-f0-9-]{36}$/i.test(resource), 422, 'INVALID_ENCRYPTION_CONTEXT');
  const aad = Buffer.from(JSON.stringify([platformFormat, tenant, purpose, resource]));
  const id = operation === 'encrypt' ? ring.active : data?.key_id;
  assert(typeof id === 'string' && Object.hasOwn(ring.keys, id), 422, 'UNKNOWN_ENCRYPTION_KEY');
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(ring.keys[id], 'hex'), Buffer.from(tenant), Buffer.from(`ekyc:${purpose}:v1`), 32));
  try {
    if (operation === 'encrypt') {
      assert(data !== undefined && data !== null, 422, 'DATA_REQUIRED');
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
      return { format: platformFormat, key_id: id, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    }
    assert(operation === 'decrypt' && data?.format === platformFormat && Buffer.from(data.nonce, 'base64').length === 12 && Buffer.from(data.tag, 'base64').length === 16, 422, 'INVALID_ENCRYPTED_DATA');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.nonce, 'base64'));
    decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } catch { assert(false, 422, 'INVALID_ENCRYPTED_DATA'); }
  finally { key.fill(0); }
}
