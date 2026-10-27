import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { sealDevelopmentMaterial, openDevelopmentMaterial } from '../../ekyc-backend-master/src/development-transactions.js';
const cfg = { encryptionMock: true, production: false };
const row = () => ({ id: randomUUID(), tenant_id: randomUUID(), expires_at: new Date(Date.now() + 86400000) });
const material = { key: randomBytes(32).toString('base64'), iv: randomBytes(16).toString('base64') };
afterEach(() => vi.unstubAllEnvs());
test('development transactions encrypt at rest with fresh nonces and tenant-bound authenticated data', () => {
  vi.stubEnv('DEVELOPMENT_TRANSACTION_KEY', 'a'.repeat(64)); vi.stubEnv('DEVELOPMENT_TRANSACTION_KEY_FILE', '');
  const record = row(), envelope = sealDevelopmentMaterial(cfg, record, material);
  expect(envelope).not.toHaveProperty('key'); expect(JSON.stringify(envelope)).not.toContain(material.key); expect(JSON.stringify(envelope)).not.toContain(material.iv);
  expect(openDevelopmentMaterial(cfg, { ...record, encrypted_material: envelope })).toEqual(material);
  expect(sealDevelopmentMaterial(cfg, record, material).nonce).not.toBe(envelope.nonce);
  for (const altered of [{ tenant_id: randomUUID() }, { id: randomUUID() }, { expires_at: new Date(Date.now() + 200000) }]) expect(() => openDevelopmentMaterial(cfg, { ...record, ...altered, encrypted_material: envelope })).toThrow('INVALID_DEVELOPMENT_TRANSACTION');
  expect(() => openDevelopmentMaterial(cfg, { ...record, encrypted_material: { ...envelope, tag: randomBytes(16).toString('base64') } })).toThrow('INVALID_DEVELOPMENT_TRANSACTION');
});
test('development encryption refuses production, missing keys, and expired material', () => {
  vi.stubEnv('DEVELOPMENT_TRANSACTION_KEY', ''); vi.stubEnv('DEVELOPMENT_TRANSACTION_KEY_FILE', ''); expect(() => sealDevelopmentMaterial(cfg, row(), material)).toThrow('DEVELOPMENT_TRANSACTION_KEY_NOT_CONFIGURED');
  vi.stubEnv('DEVELOPMENT_TRANSACTION_KEY', 'a'.repeat(64)); expect(() => sealDevelopmentMaterial({ ...cfg, production: true }, row(), material)).toThrow('DEVELOPMENT_ENCRYPTION_FORBIDDEN');
  expect(() => sealDevelopmentMaterial({ ...cfg, encryptionMock: false }, row(), material)).toThrow('DEVELOPMENT_ENCRYPTION_FORBIDDEN');
  const record = row(), encrypted_material = sealDevelopmentMaterial(cfg, record, material); expect(() => openDevelopmentMaterial(cfg, { ...record, expires_at: new Date(0), encrypted_material })).toThrow('TRANSACTION_EXPIRED');
});
