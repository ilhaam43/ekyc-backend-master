import { randomUUID } from 'node:crypto';
import { assert, AppError } from '@ekyc/shared/errors';
import { activeStates } from '@ekyc/shared/db';
import { enqueue, audit } from '@ekyc/shared/outbox';

export class CustomerDeletion {
  constructor(db, cfg, storage) { this.db = db; this.cfg = cfg; this.storage = storage; }
  async status(actor, userId) {
    assert(actor.role === 'partner', 403, 'PARTNER_REQUIRED');
    assert(typeof userId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(userId), 422, 'INVALID_CUSTOMER_ID');
    const row = await this.db('platform_customer_deletions').where({ tenant_id: actor.tenant_id, user_id: userId }).first();
    assert(row, 404, 'DELETION_NOT_FOUND'); return row;
  }
  async request(actor, userId) {
    assert(actor.role === 'partner', 403, 'PARTNER_REQUIRED');
    assert(typeof userId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(userId), 422, 'INVALID_CUSTOMER_ID');
    const result = await this.db.transaction(async trx => {
      const tenant = await trx('platform_tenants').where({ id: actor.tenant_id, active: true }).forUpdate().first(); assert(tenant, 403, 'TENANT_INACTIVE');
      const user = await trx('platform_customers').where({ id: userId, tenant_id: tenant.id }).forUpdate().first(); assert(user, 404, 'CUSTOMER_NOT_FOUND');
      const prior = await trx('platform_customer_deletions').where({ tenant_id: tenant.id, user_id: userId }).first(); if (prior) return prior;
      assert(!await trx('platform_calls').where({ tenant_id: tenant.id, user_id: userId }).whereIn('state', activeStates).first(), 409, 'CUSTOMER_HAS_ACTIVE_CALL');
      const pending_reason = tenant.legal_hold ? 'LEGAL_HOLD' : tenant.recording_retention_days == null ? 'RETENTION_NOT_CONFIGURED' : 'RETENTION_CHECK_PENDING';
      const [row] = await trx('platform_customer_deletions').insert({ id: randomUUID(), tenant_id: tenant.id, user_id: userId, requested_by: actor.sub || null, pending_reason }).returning('*');
      await trx('platform_customers').where({ id: userId }).update({ deleted_at: user.deleted_at || new Date(), updated_at: new Date() });
      await enqueue(trx, 'customer.purge', `customer-purge:${row.id}`, { deletion_id: row.id, tenant_id: tenant.id, user_id: userId });
      await audit(trx, tenant.id, actor.sub || null, userId, 'customer.deletion_requested', { deletion_id: row.id }); return row;
    });
    // Revoke after the customer lock commits to avoid a grant-exchange lock cycle.
    await this.db('platform_sessions').where({ tenant_id: actor.tenant_id, subject_id: userId }).whereNull('revoked_at').update({ revoked_at: new Date(), refresh_hash: null });
    return result;
  }
  async process({ deletion_id, tenant_id, user_id }) {
    const result = await this.db.transaction(async trx => {
      const tenant = await trx('platform_tenants').where({ id: tenant_id }).forUpdate().first(); assert(tenant, 404, 'TENANT_NOT_FOUND');
      const user = await trx('platform_customers').where({ id: user_id, tenant_id }).forUpdate().first(); assert(user, 404, 'CUSTOMER_NOT_FOUND');
      const job = await trx('platform_customer_deletions').where({ id: deletion_id, tenant_id, user_id }).forUpdate().first(); assert(job, 404, 'DELETION_NOT_FOUND');
      if (job.state === 'purged') return job;
      const calls = await trx('platform_calls').where({ tenant_id, user_id });
      const ids = calls.map(row => row.id);
      const recordings = await trx('platform_recordings').where({ tenant_id }).whereIn('call_id', ids);
      let reason = tenant.legal_hold ? 'LEGAL_HOLD' : tenant.recording_retention_days == null ? 'RETENTION_NOT_CONFIGURED' : !Number.isInteger(tenant.recording_retention_days) || tenant.recording_retention_days < 0 || tenant.recording_retention_days > 36500 ? 'INVALID_RETENTION_POLICY' : calls.some(row => activeStates.includes(row.state)) ? 'CUSTOMER_HAS_ACTIVE_CALL' : recordings.some(row => !['stored', 'failed'].includes(row.state) || row.state === 'failed' && row.started_at && !row.stopped_at) ? 'RECORDING_NOT_SETTLED' : null;
      const anchor = Math.max(new Date(user.created_at).getTime(), ...calls.map(row => new Date(row.ended_at || row.created_at).getTime()));
      const eligible_at = Number.isInteger(tenant.recording_retention_days) && tenant.recording_retention_days >= 0 && tenant.recording_retention_days <= 36500 ? new Date(anchor + tenant.recording_retention_days * 86400000) : null;
      if (!reason && eligible_at > new Date()) reason = 'RETENTION_PERIOD';
      if (reason) { const [pending] = await trx('platform_customer_deletions').where({ id: job.id }).update({ state: 'pending', pending_reason: reason, eligible_at }).returning('*'); return pending; }
      await trx('platform_customer_deletions').where({ id: job.id }).update({ state: 'purging', pending_reason: null, eligible_at });
      const documents = await trx('platform_documents').where({ tenant_id, user_id });
      const mapping = await trx('platform_tenant_storage').where({ tenant_id }).first();
      // Build and validate the complete manifest before deleting any objects.
      const objects = [...documents.map(row => ({ bucket: row.bucket, key: row.object_key, prefix: `${tenant_id}/${user_id}/`, allowed: [this.cfg.documentBucket] })), ...recordings.filter(row => row.object_key).map(row => ({ bucket: row.bucket || this.cfg.recordingBucket, key: row.object_key, prefix: `${tenant_id}/${user_id}/${row.call_id}/`, allowed: [this.cfg.recordingBucket, mapping?.recording_bucket].filter(Boolean) }))];
      for (const object of objects) assert(object.allowed.includes(object.bucket) && object.key.startsWith(object.prefix) && !object.key.split('/').includes('..'), 409, 'OBJECT_PURGE_SCOPE_MISMATCH');
      for (const object of objects) await this.storage.delete(object.bucket, object.key);
      // Only opaque history and aggregate quota remain. No customer ciphertext,
      // downloadable object references, device tokens, sessions or free-text reasons.
      await trx('platform_documents').where({ tenant_id, user_id }).delete();
      await trx('platform_recordings').where({ tenant_id }).whereIn('call_id', ids).update({ object_key: null, bucket: null, sha256: null, bytes: null, state: 'purged' });
      await trx('platform_calls').where({ tenant_id, user_id }).update({ notification: {}, reason: null });
      for (const table of ['platform_sessions', 'platform_link_grants']) await trx(table).where({ tenant_id, subject_id: user_id }).delete();
      for (const table of ['platform_otps', 'platform_decisions']) await trx(table).where({ tenant_id, user_id }).delete();
      await trx('platform_callbacks').where({ tenant_id }).where(builder => builder.whereIn('submission_id', [user_id, ...ids]).orWhereRaw("data->>'user_id' = ?", [user_id]).orWhereRaw("data->>'customer_id' = ?", [user_id])).delete();
      await trx('dashboard_audit').where(builder => builder.whereRaw("metadata->>'id' = ?", [user_id]).orWhereRaw("metadata->>'customer_id' = ?", [user_id]).orWhereRaw("metadata->>'user_id' = ?", [user_id])).update({ metadata: {} });
      await trx('dashboard_video_call_requests').where({ customer_id: user_id }).delete();
      await trx('dashboard_customer_applications').where({ customer_id: user_id }).delete();
      await trx('platform_outbox').where(builder => builder.whereRaw("payload->>'user_id' = ?", [user_id]).orWhereIn(trx.raw("payload->>'call_id'"), ids).orWhereRaw("payload->>'subject_id' = ?", [user_id]).orWhereRaw("payload #>> '{data,user_id}' = ?", [user_id]).orWhereRaw("payload #>> '{data,call,user_id}' = ?", [user_id]).orWhereIn(trx.raw("payload #>> '{data,call_id}'"), ids)).whereNot({ topic: 'customer.purge' }).delete();
      await trx('platform_audit').where({ tenant_id }).where(builder => builder.where({ subject_id: user_id }).orWhere({ actor_id: user_id })).update({ subject_id: null, actor_id: null, metadata: {} });
      await trx('platform_customers').where({ id: user_id }).update({ data: {}, actor_id: null, verification_status: 'purged', updated_at: new Date() });
      const [done] = await trx('platform_customer_deletions').where({ id: job.id }).update({ state: 'purged', pending_reason: null, requested_by: null, purged_at: new Date() }).returning('*');
      await audit(trx, tenant_id, null, null, 'customer.purged', { deletion_id: job.id, documents: documents.length, recordings: recordings.length }); return done;
    });
    if (result.state !== 'purged') throw new AppError(409, result.pending_reason); return result;
  }
}
