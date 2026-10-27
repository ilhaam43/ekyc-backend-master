import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { assert, errorHandler } from '../../packages/shared/src/errors.js';
import { crypt, validateKeyring } from './crypto.js';

export function encryptionApp(keyring, tokenSecret) {
  validateKeyring(keyring); assert(tokenSecret?.length >= 32, 500, 'ENCRYPTION_TOKEN_REQUIRED');
  const app = express(); app.disable('x-powered-by'); app.use(helmet());
  app.use((_req, res, next) => { res.set('cache-control', 'no-store'); next(); });
  app.get('/health/ready', (_req, res) => res.json({ status: 'ready' }));
  app.use(rateLimit({ windowMs: 60000, limit: 1000, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use(express.json({ limit: '1mb', verify: (req, _res, bytes) => { req.digest = createHash('sha256').update(bytes).digest('hex'); } }));
  for (const operation of ['encrypt', 'decrypt']) app.post(`/v1/${operation}`, (req, res) => {
    let claims;
    try { claims = jwt.verify(req.headers.authorization?.replace(/^Bearer /, ''), tokenSecret, { algorithms: ['HS256'], issuer: 'ekyc-platform', audience: 'ekyc-crypto', maxAge: '20s' }); }
    catch { assert(false, 401, 'INVALID_ENCRYPTION_TOKEN'); }
    assert(claims.operation === operation && Number.isInteger(claims.exp) && Number.isInteger(claims.iat) && claims.exp - claims.iat <= 20 && /^[a-f0-9]{64}$/.test(claims.digest) && req.digest && timingSafeEqual(Buffer.from(claims.digest), Buffer.from(req.digest)), 401, 'INVALID_ENCRYPTION_TOKEN');
    res.json({ success: true, data: crypt(keyring, operation, req.body) });
  });
  app.use((_req, res) => res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } }));
  app.use(errorHandler); return app;
}
