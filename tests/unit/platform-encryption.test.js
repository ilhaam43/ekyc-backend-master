import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { crypt, validateKeyring } from '../../infra/encryption/crypto.js';
import { encryptionApp } from '../../infra/encryption/app.js';
const ring = { active: 'v1', keys: { v1: randomBytes(32).toString('hex') } };
const input = () => ({ tenant_id: randomUUID(), resource_id: randomUUID(), purpose: 'customer-profile', data: { name: 'Synthetic name', id_number: 'TEST', notes: 'private note' } });
test('AES-GCM roundtrip, random nonces and tenant/resource/purpose integrity', () => {
  const row = input(), encrypted = crypt(ring, 'encrypt', row);
  expect(JSON.stringify(encrypted)).not.toContain('Synthetic');
  expect(encrypted.nonce).not.toBe(crypt(ring, 'encrypt', row).nonce);
  expect(crypt(ring, 'decrypt', { ...row, data: encrypted })).toEqual(row.data);
  for (const changed of [{ tenant_id: randomUUID() }, { resource_id: randomUUID() }, { purpose: 'secure-transaction' }]) expect(() => crypt(ring, 'decrypt', { ...row, ...changed, data: encrypted })).toThrow();
  expect(() => crypt(ring, 'decrypt', { ...row, data: { ...encrypted, tag: randomBytes(16).toString('base64') } })).toThrow();
});
test('rotation retains old decrypt keys; new writes use active key; malformed rings fail startup', () => {
  const row = input(), old = crypt(ring, 'encrypt', row), rotated = { active: 'v2', keys: { ...ring.keys, v2: randomBytes(32).toString('hex') } };
  expect(crypt(rotated, 'decrypt', { ...row, data: old })).toEqual(row.data);
  expect(crypt(rotated, 'encrypt', row).key_id).toBe('v2');
  expect(() => validateKeyring({ active: 'v1', keys: { v1: 'weak' } })).toThrow();
  expect(() => validateKeyring({ active: 'constructor', keys: {} })).toThrow();
  expect(() => crypt({ active: 'v2', keys: { v2: rotated.keys.v2 } }, 'decrypt', { ...row, data: old })).toThrow();
});
test('HTTP service requires short-lived signature bound to exact body and operation', async () => {
  const secret = randomBytes(48).toString('hex'), app = encryptionApp(ring, secret), row = input(), body = JSON.stringify(row);
  const token = (patch = {}, options = {}) => jwt.sign({ operation: 'encrypt', digest: createHash('sha256').update(body).digest('hex'), ...patch }, secret, { algorithm: 'HS256', issuer: 'ekyc-platform', audience: 'ekyc-crypto', expiresIn: 15, ...options });
  expect((await request(app).get('/health/ready')).status).toBe(200);
  expect((await request(app).post('/v1/encrypt').send(row)).status).toBe(401);
  const send = (path, data, credential) => request(app).post(path).set('content-type', 'application/json').set('authorization', 'Bearer ' + credential).send(data);
  const good = await send('/v1/encrypt', body, token()); expect(good.status).toBe(200); expect(good.headers['cache-control']).toBe('no-store');
  expect((await send('/v1/encrypt', JSON.stringify({ ...row, tenant_id: randomUUID() }), token())).status).toBe(401);
  expect((await send('/v1/decrypt', body, token())).status).toBe(401);
  expect((await send('/v1/encrypt', body, token({}, { expiresIn: -1 }))).status).toBe(401);
  expect((await send('/v1/encrypt', body, token({}, { audience: 'wrong' }))).status).toBe(401);
  expect((await send('/v1/encrypt', body, token({}, { expiresIn: 3600 }))).status).toBe(401);
});
