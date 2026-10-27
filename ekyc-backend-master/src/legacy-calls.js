import { assert } from '@ekyc/shared/errors';
import { activeStates } from '@ekyc/shared/db';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export class LegacyCalls {
  constructor(db, cfg, customers) { this.db = db; this.cfg = cfg; this.customers = customers; }
  async call(path, body, headers) {
    assert(this.cfg.callsUrl, 503, 'CALLS_NOT_CONFIGURED');
    let response;
    try { response = await fetch(`${this.cfg.callsUrl.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error' }); }
    catch { assert(false, 503, 'CALLS_UNAVAILABLE'); }
    const result = await response.json().catch(() => null);
    assert(result, 502, 'CALLS_INVALID_RESPONSE');
    assert(response.ok, response.status, result.error?.code || 'CALLS_REQUEST_FAILED'); return result.data;
  }
  gateway(actor) { return { 'x-gateway-secret': this.cfg.gatewaySecret, 'x-application-id': actor.tenant_id }; }
  async register(actor, data, key) {
    assert(actor.role === 'partner', 403, 'PARTNER_REQUIRED'); await this.customers.row(actor, data.user_id);
    assert(typeof key === 'string' && key.length >= 8 && key.length <= 128, 400, 'IDEMPOTENCY_KEY_REQUIRED');
    return this.call('/api/v2/calls', data, { ...this.gateway(actor), 'idempotency-key': key });
  }
  async actorCredential(actor, actorId, userId) {
    assert(actor.role === 'partner', 403, 'PARTNER_REQUIRED'); assert(uuid(actorId), 422, 'INVALID_ACTOR_ID');
    assert(await this.db('platform_actors').where({ id: actorId, tenant_id: actor.tenant_id }).first(), 404, 'ACTOR_NOT_FOUND');
    let query = this.db('platform_customers').where({ actor_id: actorId, tenant_id: actor.tenant_id }).whereNull('deleted_at');
    if (userId !== undefined) { assert(uuid(userId), 422, 'INVALID_CUSTOMER_ID'); query = query.where({ id: userId }); }
    const users = await query.select('id').limit(2); assert(users.length, 404, 'ACTOR_CUSTOMER_NOT_FOUND'); assert(users.length === 1, 409, 'CUSTOMER_ID_REQUIRED');
    const grant = await this.call('/api/v2/customer-grants', { user_id: users[0].id, expires_in: 3600 }, this.gateway(actor));
    return { actor_id: actorId, customer_id: users[0].id, code: grant.code, apikey: grant.code, credential_type: 'one_time_customer_grant', scope: 'customer:session', expires_in: grant.expires_in, join_url: grant.join_url, exchange_path: '/api/v2/sessions/customer' };
  }
  async decide(actor, userId, data, outcome, authorization) {
    assert(['agent', 'partner'].includes(actor.role), 403, 'FORBIDDEN'); assert(uuid(userId), 422, 'INVALID_CUSTOMER_ID'); await this.customers.row(actor, userId);
    assert(data && typeof data === 'object' && !Array.isArray(data), 422, 'INVALID_DECISION');
    if (data.call_id !== undefined) assert(uuid(data.call_id), 422, 'INVALID_CALL_ID');
    assert(data.reason === undefined || typeof data.reason === 'string' && data.reason.length <= 2000, 422, 'INVALID_REASON');
    let query = this.db('platform_calls').where({ tenant_id: actor.tenant_id, user_id: userId });
    if (data.call_id) query = query.where({ id: data.call_id });
    else { assert(actor.role === 'agent', 422, 'CALL_ID_REQUIRED'); query = query.where({ agent_id: actor.sub, source: actor.source || 'basic' }).whereIn('state', activeStates); }
    const call = await query.orderBy('created_at', 'desc').first(); assert(call, 404, 'CALL_NOT_FOUND');
    if (actor.role === 'agent') {
      assert(call.agent_id === actor.sub && call.source === (actor.source || 'basic'), 403, 'CALL_NOT_ASSIGNED_TO_AGENT');
      return this.call(`/api/v2/calls/${call.id}/decision`, { outcome, ...(data.reason !== undefined ? { reason: data.reason } : {}) }, { authorization });
    }
    assert(['completing', 'completed'].includes(call.state), 409, 'AGENT_DECISION_REQUIRED');
    assert(call.outcome === outcome, 409, 'DECISION_CONFLICT');
    return this.customers.applyDecision({ call_id: call.id, tenant_id: actor.tenant_id, user_id: userId, outcome });
  }
}
