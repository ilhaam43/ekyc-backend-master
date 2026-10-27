# Platform-owned encryption

The platform includes its own private Node.js encryption service, `platform-crypto`, on container port 8090. It does not publish a host port or a Kong route. No external encryption-service URL, fixed IV, or legacy master secret is needed for new profiles and secure transactions.

## Run

```sh
node scripts/prepare-platform-encryption.mjs
# Set ENCRYPTION_MOCK=false and PLATFORM_ENCRYPTION_URL=http://platform-crypto:8090 in .env
docker compose -f compose.yaml -f compose.dev.yaml -f compose.kong.yaml up -d --build platform-crypto master dashboard
node --env-file=.env scripts/test-secure-transactions-deployed.mjs
node --env-file=.env scripts/test-master-api-deployed.mjs
```

New-install secret generation prepares platform secrets too. Existing .env files and key files are never overwritten. For terminal-based API development without Docker DNS, use the deployed master API or an explicitly configured private service address; the encryption service intentionally has no public localhost endpoint.

## Protection and format

The service uses Node's native AES-256-GCM and HKDF-SHA256 implementations. A random 32-byte root is stored in a versioned keyring. HKDF derives separate keys for each tenant and purpose. Each write generates a random 12-byte nonce; the authenticated context binds the format, tenant, purpose and resource UUID. Modification, wrong tenant, wrong purpose, or wrong resource fails decryption. Complete customer profiles, including nested fields, are encrypted; authorized profile API responses remain unchanged. Secure transactions retain their normal 32-byte key, 16-byte IV and 24-hour expiration, but the generated material is encrypted at rest. Their response identifies `encryption_mode: platform-service` and disables caching.

Envelope: `{format: "ekyc-aes-256-gcm-v1", key_id, nonce, tag, ciphertext}`. The new format deliberately does not claim compatibility with unknown legacy ciphertext. Tenant key metadata contains only the format marker; it does not contain the derived key or root material.

Private `POST /v1/encrypt` and `/v1/decrypt` accept `{tenant_id, purpose, resource_id, data}`. Only `customer-profile` and `secure-transaction` purposes are accepted. Each request needs a short-lived HS256 service assertion with fixed issuer/audience, operation and SHA256 of the exact request body. This protects operation and tenant/resource context from alteration. TLS must protect traffic if the service is moved off the local Docker host/private network. Browser tokens and gateway credentials cannot call this service. Responses use no-store; keys, plaintext and request bodies are not logged. The service has body-size and request-rate limits, fails startup for invalid secrets, runs as a non-root user with a read-only filesystem and no extra Linux capabilities.

## Secrets, backup and rotation

Preparation creates two ignored files excluded from Docker builds and Git:

- `.local/encryption-secrets/keyring.json`: only mounted into the encryption container.
- `.local/encryption-secrets/service-token`: mounted into the encryption container and master API.

For deployment, point `PLATFORM_ENCRYPTION_KEYRING_PATH` and `PLATFORM_ENCRYPTION_TOKEN_PATH` at protected secret files managed by the operator. Compose mounts them under `/run/secrets`. Keep an encrypted off-host backup of the complete keyring separately from database backups; loss of a root key makes its ciphertext unrecoverable. Never regenerate keys as a troubleshooting step. A deployment must verify restoring both database and matching keyring before receiving real data.

To rotate encryption roots, add a newly generated 32-byte hex key under a new ID to `keys`, retain every old entry and set `active` to the new ID. Restart platform-crypto so all writes use the new ID. Existing envelopes retain their key IDs and decrypt with old entries. Removing an old key is only safe after every reference, including backups, has been migrated or expired. Restart clients and service together when rotating the service authentication secret. Automated tests cover encryption-root rotation and missing-key refusal.

## Existing data and external compatibility

No existing profile, legacy tenant envelope or historical transaction is rewritten during activation. Local `synthetic-plaintext` fixtures remain readable only outside production and become encrypted when updated through the master API. Production never treats these fixtures as encrypted data.

Legacy ciphertext stays unchanged. Without a separately verified legacy adapter, attempts to read it fail explicitly with `LEGACY_ENCRYPTION_MIGRATION_REQUIRED`. The optional legacy adapter code remains available for a controlled import; the new default deployment does not call it. Converting legacy data requires verified plaintext/export access, audited migration and reconciliation; guessing its algorithm or using new roots cannot recover old ciphertext. Historical development transaction envelopes require their original development key and are not silently interpreted as the new format.

The 24-hour secure-transaction validity belongs to the transaction API and its consumers; private decryption is a storage primitive, not a new customer transaction authorization endpoint. Existing external encrypted-request protocols are not redefined by this service.

## Validation

Tests cover authenticated API roundtrip with production-mode configuration, complete profile/nested-data storage and update, secure transactions, tamper and cross-tenant/resource/purpose rejection, nonce uniqueness, expired/wrong-audience/altered-body assertions, root rotation, missing keys and preservation of legacy data. Local deployed checks use disposable data through Kong and inspect encrypted PostgreSQL storage; they do not substitute for an independent security review or production restore test.
