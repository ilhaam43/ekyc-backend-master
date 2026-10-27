# Secure transactions and encryption setup

**Current default:** the platform now owns its encryption service. See [platform-encryption.md](platform-encryption.md) for setup, secret mounts, rotation and legacy migration boundaries. `encryption_mode: platform-service` replaces the former localhost development-mock mode. The sections below document the previous development mode and optional legacy compatibility adapter; neither is the default for new data.

`POST /api/v1/secure-transactions` works in local development without pretending to be the missing legacy encryption service. It returns the existing `id`, base64 32-byte `key`, base64 16-byte `iv`, and 24-hour `expired_at`, plus an explicit `encryption_mode`. Responses use `Cache-Control: no-store` and `X-eKYC-Encryption-Mode`. The endpoint requires the existing trusted partner authentication; raw transaction secrets are never placed in audit metadata.

## Local development

The existing local stack uses `ENCRYPTION_MOCK=true` for synthetic data. Secure transactions previously ignored that mode and always called an absent external encryption service. The corrected path creates the transaction material locally and wraps it at rest with AES-256-GCM under a separate development key. A fresh nonce and authenticated tenant/transaction/expiry context protect each envelope. This is explicitly tagged `development-only-aes-256-gcm-v1`, not a legacy ciphertext format or production replacement. Other customer ciphertext is not rewritten.

Prepare the private key before using the development Compose override:

```sh
node scripts/prepare-development-encryption.mjs
docker compose -f compose.yaml -f compose.dev.yaml -f compose.kong.yaml up -d --build master
node --env-file=.env scripts/test-secure-transactions-deployed.mjs
```

New installations also prepare this file through `scripts/secrets.mjs`. The preparation command is idempotent: it never overwrites an existing key. The ignored file `.local/development-secrets/secure-transactions.key` is mounted as a Compose secret only into master. It is excluded from Git and Docker build context; its value is not printed. Keep the file for as long as its synthetic transaction rows need to be readable. Do not copy synthetic transactions into production. The development path is refused when `NODE_ENV=production`, even if its key is present.

A successful local response has `encryption_mode: "development-mock"`. This proves local issuance and protected at-rest storage; it does not prove production-provider connectivity or every legacy encrypted-request consumer workflow.

## What the search found

A read-only search of the legacy repositories found `MECHLAB_ENCRYPTION_SERVICE_HOST`, whose default is `http://encryptionservice:8000/v1`. The HTTP helper posts `{ key, IV, data, whitelist?, casts? }` to `/encrypt` and `/decrypt`. This payload contract remains unchanged on the external path.

The sibling `C:\xampp\htdocs\mechlab-cluster-deployment-repo` contains:

- `deployment/mechlab/manifest/encryptionservice/01-deploy-encryptionservice.yaml`: Kubernetes deployment template, with registry image and an `imagePullSecrets` reference named `gitlabregistryauth`.
- `deployment/mechlab/manifest/encryptionservice/02-service-encryptionservice.yaml`: internal ClusterIP service.
- `deployment/mechlab/output.yaml`: rendered image reference `registry.gitlab.com/infinid-dev/ekyc-services/encryption:2a57f0f23aeca6194e2d66903ffebca5fdb6dd74` and the internal service URL.

No running/stopped encryption container or local encryption image was found. DNS lookup of `encryptionservice` inside the application network returned `ENOTFOUND`. An existing-auth Docker manifest lookup against the exact registry image timed out; image availability/access and compatibility are not verified. Public searches for the service setting did not locate a usable implementation. Embedded legacy master-key defaults and deployment credentials were not copied into this replacement.

## Staging and production

Set `ENCRYPTION_MOCK=false`, configure `ENCRYPTION_URL` to the verified private service (including `/v1` when appropriate), and inject `MASTER_ENCRYPTION_KEY` and `MASTER_ENCRYPTION_IV` or their `*_FILE` paths. Compose passes the file-path variables; the deployment must mount the referenced secret files. Retain the original master material needed to read existing tenant ciphertext; do not rotate it casually or substitute the development key.

The external implementation continues to unwrap `tenant.encryption` through `/decrypt`, then sends the transaction material to `/encrypt` with the tenant's existing `encryption_key` and `iv`. Its returned encrypted payload is stored unchanged. Responses identify `encryption_mode: "external-service"`. Redirects are rejected; missing configuration, malformed responses and connectivity errors return explicit 503 errors rather than success or plaintext fallback. Existing tenants require valid encrypted tenant-key envelopes before external mode can work.

Actual service access, approved secret injection and real staging round-trip/ciphertext compatibility remain required before claiming the production encryption integration works.

## Validation

Automated coverage includes authenticated local issuance, key/IV sizes, expiry, encrypted storage round trip, fresh nonces, tenant/transaction binding, tampering, audit redaction, production rejection and the unchanged external HTTP contract. External success/failure tests use an explicit HTTP mock, not the real service. The deployed acceptance script uses disposable tenant rows and checks Kong forwarding, storage round trip and absence of plaintext in database/audit metadata. It removes its test records afterward.
