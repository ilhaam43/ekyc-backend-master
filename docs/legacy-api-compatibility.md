# Legacy master API compatibility

These five existing routes now perform real work. They retain the current recorded-call, tenant-isolation and retention rules. Authentication is unchanged: customer/agent sessions use Bearer tokens; trusted partner backends use injected gateway credentials and the tenant ID. The bank customer-link entry still uses its Kong consumer API key.

| Existing endpoint | New behavior |
| --- | --- |
| `POST /api/v1/videocalls` | Registers a real waiting call through the call service. Supply `Idempotency-Key` and `{ "user_id": "<customer UUID>" }`. Repeating the same request returns the existing call without another quota deduction. |
| `GET /api/v1/actors/:id/apikey?user_id=<customer UUID>` | Returns a one-hour (3,600-second), single-use customer grant. `user_id` may be omitted only when exactly one active customer belongs to the actor. The `apikey` alias contains the grant code, never the bank's gateway key. |
| `PUT /api/v1/users/:id/verify` | An assigned agent's Bearer session delegates `{ "call_id": "<call UUID>", "reason": "..." }` to the call decision API with outcome `verified`. |
| `PUT /api/v1/users/:id/reject` | The same adapter with outcome `not_verified`. |
| `DELETE /api/v1/users/:id` | Accepts an idempotent, audited deletion request. Returns 202 while pending and 200 once purged. |
| `GET /api/v1/users/:id/deletion` | Returns the deletion receipt, state, pending reason, eligibility time and completion time. |

## Actor grant exchange

Exchange the returned `code` or `apikey` via `POST /api/v2/sessions/customer` with `{ "code": "..." }`. The response is a normal customer session. A consumed or expired code cannot be exchanged again. The returned `join_url` supports the built-in customer page. Use `Cache-Control: no-store`; do not log or persist the code in application logs. This endpoint does not restore the old behavior of revealing a bank-wide API key.

## Verification timing

An agent must own the call and the call must be active, consented and recording. The decision response enters `completing`; the final customer outcome remains gated on durable recording storage and the existing completion outbox. No unrecorded verification is introduced.

A trusted partner may supply an explicit `call_id` to apply/retry the matching decision after that call is `completing` or `completed` and the recording is stored. It cannot invent an agent decision, change the recorded outcome, access another tenant, or choose another customer's call. Duplicate requests are idempotent. Conflicting outcomes return `DECISION_CONFLICT`.

## Deletion lifecycle

The additive `009_customer_deletions` migration stores durable requests. DELETE marks the customer unavailable for new calls, credentials, updates and document uploads, and revokes customer sessions. Active calls return `CUSTOMER_HAS_ACTIVE_CALL` so their completion cannot be broken by deletion.

The master service drains only explicitly queued `customer.purge` jobs. It locks the tenant/customer, verifies legal hold and the existing tenant `recording_retention_days` setting, checks settled call/recording state, and validates the entire object manifest before removing files. Zero days is an explicit immediate-purge policy; positive values retain data until the most recent call/customer timestamp plus that interval. Null retains pilot data until an administrator supplies an explicit policy. No existing tenant policy is changed by this migration.

When eligible, the worker deletes owned documents and stored recordings from SeaweedFS, erases the profile ciphertext, sessions/grants, linked OTP/decision data and identifiable owned callback/outbox/audit references. Anonymous call history, quota aggregates and an opaque deletion receipt remain. Legacy callback records that have no customer/call association and provider-side archives require their own reconciliation/retention process; this worker cannot infer their ownership.

Storage errors leave the request retriable and never mark it purged. Partial S3 deletion is safe to retry because object deletion is idempotent; database erasure commits only after all object deletions succeed. Unsettled recordings, legal holds, missing/invalid retention policies and mismatched bucket/key ownership remain pending for operator reconciliation. Customer data in external backups is governed by the separate backup retention process.

Apply migrations before deploying the updated master/call services. Existing bank/customer data is preserved; no tenant-wide automatic deletion is enabled. Configure retention only through an authorized administrative database/configuration process, not a customer-supplied request parameter.

## Validation

- Six isolated integration scenarios exercise real HTTP communication between master and call apps, both outcomes, missing recording rejection, idempotency, scoped/expired/reused actor grants, legal holds, retention periods, active calls, storage failure/retry and cross-tenant/object protection.
- `node --env-file=.env scripts/test-legacy-api-deployed.mjs` exercises localhost Kong, both deployed services, the durable worker and real SeaweedFS using disposable data. Recording metadata/object bytes in this script are synthetic; it does not claim a new real Jitsi recording.
- `node --env-file=.env scripts/test-master-api-deployed.mjs` checks the complete current master route registry.
