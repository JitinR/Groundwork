# Release and deployment baseline

The hosted Vercel application uses Node 22 and Supabase PostgreSQL's private
`groundwork` schema. The persistent-server/SQLite configuration below remains
available for self-hosted deployments; it is not the Vercel persistence model.
Build with `npm ci && npm run build`, and check `/api/health` after release.
See `VERCEL.md`, `SUPABASE.md` and `OPERATIONS.md` for the hosted configuration.

## Verified release history

Groundwork 1.1.1 at `00d285bdf7772bd45ded63bd2366446adc0d9989` passed
[main CI 39960744109](https://github.com/jitinraavi/Secure-Nexus/actions/runs/39960744109),
including verify, native PostgreSQL 17 synthetic backup/restore and release-gate.
The authorized post-CI deploy path produced READY Vercel deployment
`dpl_DQ5dyGpQcnJgGJMnTvtPFxrnR9Ad` with that exact source SHA at
`https://secure-nexus-xi.vercel.app/`.

A disposable live smoke account passed password login, versioned session,
encrypted project save/reload, stale-write rejection, snapshot restore, geometry
upload, SSE abort cleanup and logout/session revocation. Fixture cleanup was
verified. Public health/static routing and protected operations denial were also
checked. These results do not prove OTP inbox delivery or optional provider flows.
Public external health monitoring and the private runtime check/SMTP route are
configured; retain their own current run and delivery evidence.

The first private real-data backup comparison found hosted/local floating-point
serialization differences. The corrective 1.1.2 release is in progress; do not
claim a successful real-data drill or activate backup scheduling until a fresh
encrypted archive, isolated restore, full comparison and artifact check pass.
Each new release requires its own exact-source CI and deployment evidence; this
historical 1.1.1 record does not certify a later patch.

## Release checks

Every push and pull request runs `.github/workflows/ci.yml` with Node 22 and the
root npm cache. The required gates are:

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run lint
npm run build
npm run test -w server
npm run test -w client
npm run test:operations
npm run test:capacity
npm run test:capacity:postgres
```

CI additionally checks the integrated deployment output, PostgreSQL API flow,
studio interactions and private mail setup. Capacity runs use disposable
synthetic databases; their sanitized JSON artifacts are regression evidence,
not production load measurements. Its `backup-drill` job uses native
PostgreSQL 17 with synthetic records to export an encrypted application archive,
authenticate it, restore to an empty isolated database and compare all table
fingerprints. `release-gate` succeeds only when `verify` and `backup-drill` pass.
No live credentials are needed by CI. Actions are pinned to full official commits;
see the reviewed pin sources below.

## Exact-commit release on Vercel Hobby

The `Release readiness` manual workflow and `npm run release:check` verify that
`RELEASE_COMMIT` is the current production-branch full SHA and that the newest
matching push run of `.github/workflows/ci.yml` completed successfully. The local
script requires `GITHUB_REPOSITORY=owner/repository`, `RELEASE_COMMIT`, optionally
`RELEASE_BRANCH` (default `main`), and a private read-only `GITHUB_TOKEN` for a
private repository. It prints a reviewable evidence summary and never deploys.
A later failing/in-progress rerun invalidates earlier success.

The checked-in `vercel.json` disables normal Git auto-deployment of `main` while
leaving unspecified preview branches enabled:

```json
{ "git": { "deploymentEnabled": { "main": false } } }
```

`.github/workflows/deploy-production.yml` responds only to a successful push-CI
run for this repository's `main` branch. It checks out that run's SHA, rechecks
the current branch and newest CI attempt, then calls the single project-scoped
`VERCEL_DEPLOY_HOOK` stored privately in the `production` environment. No npm
installation or dependency lifecycle code receives that hook. A failed or
ambiguous hook acknowledgment is not retried automatically; inspect Vercel first.

Read-only GitHub evidence requests permit at most two attempts, with a 250 ms
backoff and a 15-second limit per attempt. The retry helper rejects non-GET
methods, request bodies and non-GitHub destinations. Preview reads also respect
their existing wait deadline. The hook POST is made exactly once, with up to
60 seconds to acknowledge it; a pending acknowledgement is not a READY release.
Fixed diagnostic codes distinguish unavailable/rejected evidence, invalid
configuration and `HOOK_ACK_UNCONFIRMED` without printing provider bodies,
request URLs, credentials or underlying exception messages. If acknowledgement
is unconfirmed, inspect deployments for the exact SHA before deciding on further
delivery; never automatically rerun the hook to resolve that uncertainty.

The Vercel build command runs `scripts/deploy-after-ci.mjs --build-guard` before
building. It verifies matching repository/branch/commit metadata against current
successful CI evidence; production requires `main`. This second check refuses
an untested branch head if the deploy hook races a later push. CLI deployments
must also supply matching Git metadata or the explicit
`GROUNDWORK_RELEASE_COMMIT`/`GROUNDWORK_RELEASE_BRANCH` values. The current public
repository requires no persistent GitHub credential in Vercel for these reads.

Preview builds can start while GitHub Actions is still queued or running. The
preview guard waits up to 30 minutes, polling only the matching push-CI workflow
once every two minutes. It then rechecks the exact branch head, newest CI attempt
and all three required jobs before building. Failed, cancelled, foreign or
malformed evidence remains blocked. Production keeps the immediate strict guard
and the existing post-CI deploy hook. Logs distinguish waiting for CI from an
actual verification failure; a waiting preview does not need a manual redeploy.
The bounded wait fits within Vercel's
[45-minute build limit](https://vercel.com/docs/deployments/troubleshoot-a-build).

The hook/build guard path is activated and the 1.1.1 exact-source deployment
above passed. Main requires `release-gate` with branch protection. For a new
environment, require matching hook/workflow/build evidence before describing
that path as activated. People with deployment or repository administration
credentials can deliberately change/bypass these controls. This setup does not
provision paid Vercel Deployment Checks. See
[Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration).

1. Freeze the reviewed production-branch SHA; wait for the full matching CI run.
2. Run `Release readiness` for that exact SHA and retain its successful run URL.
3. Verify target Vercel team/project, canonical origin, production environment,
   schema compatibility, stable application key, latest encrypted archive and a
   known-good rollback deployment. Keep administrator URLs out of Vercel runtime.
4. The authorized post-CI workflow triggers that exact tested main revision
   through the existing Vercel project. Inspect the build guard and deployment
   result. For an explicit authorized CLI release, stage production without domain
   assignment, test it and promote that production deployment. Promoting a
   preview can rebuild with production variables, so repeat validation if the
   released build differs. Never silently substitute a newer branch head.
5. Verify public health and static routing, password/OTP login, secure cookies,
   CSRF rejection, unauthorized access denial, a synthetic project save/reload,
   logout, and the external monitor. Real mail delivery needs an authorized inbox
   check. Record deployment URL/ID, full SHA, CI and readiness URLs, schema
   version, smoke results and operator in the release record.
6. On failure, stop promotion or use the reviewed compatible rollback deployment.
   Data migrations require a separate recovery decision; switching application
   code does not reverse database writes. Follow `INCIDENTS.md`.

Do not claim that passing local tests proves a remote CI run, external monitor,
offsite backup, restore drill or Vercel deployment has completed.

## Production secrets and persistence

Configure secrets in the deployment platform, never in the repository, client
bundle, or CI logs. Render account credentials and these service values must be
configured by the repository/service owner; this workflow does not provision or
manage Render credentials.

- `MASTER_KEY` is required in production and must be a stable base64-encoded
  32-byte secret. Generate one once (for example,
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`),
  store it in the owner-controlled secret store, and preserve it across every
  deploy. Changing or losing it makes encrypted projects, photos and MFA seeds
  undecryptable. MFA uses a separate derived encryption key and binds each seed
  to its user ID. Startup migrates legacy plaintext seeds into encrypted values.
  For a planned rotation, set `PREVIOUS_MASTER_KEY` to the old key while existing
  ciphertext is migrated; retain matching keys and database backups until every
  encrypted record has been rotated. Do not generate a new key on each deploy.
- `GROUNDWORK_DATA_DIR` must point to persistent storage. On Render use the
  persistent disk mounted at `/var/data` and set `GROUNDWORK_DATA_DIR=/var/data`.
  Production refuses to start without it. The SQLite database is
  `$GROUNDWORK_DATA_DIR/groundwork.db`; `DB_PATH`, when used, is a directory
  override and does not change the filename.
- `NODE_ENV=production` must be set for the production service. Keep the
  platform-provided `PORT` value. Unknown `NODE_ENV` values are rejected.
- `BIND_HOST` defaults to `0.0.0.0` in production and `127.0.0.1` in development
  and test. Development/test refuses non-loopback binds. Protect production and
  staging through the hosting platform's TLS, firewall and access controls.
- `PAYMENTS_MODE=live` is mandatory in production. Missing, invalid and demo
  modes fail startup; without live provider credentials checkout stays unavailable.

### Private AI, mail, and payment configuration

All of these values are read by the server and must remain private:

- AI: `AI_API_KEY` and `AI_MODEL`; optionally set `AI_BASE_URL` for an
  OpenAI-compatible provider other than the default.
- Mail via SMTP: `MAIL_PROVIDER=smtp`, `MAIL_HOST`, `MAIL_PORT`,
  `MAIL_SECURE`, `MAIL_USER`, `MAIL_PASS`, and `MAIL_FROM`.
- Mail via Resend: `MAIL_PROVIDER=resend`, `RESEND_API_KEY`, and `MAIL_FROM`.
  Production has no console-mail fallback and never returns or logs OTPs. Verify
  real delivery before onboarding users: missing or failed delivery returns an
  unavailable response. SMTP requires TLS in production.
  Local development can explicitly opt in with `GROUNDWORK_DEV_OTP=1`; returned
  codes additionally require loopback peer, request host, origin (if present)
  and effective IP. Keep this opt-in disabled outside an isolated local workflow.
- Payments: set `PAYMENTS_MODE=live` in production and configure the provider
  being offered: Razorpay uses `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and
  `RAZORPAY_WEBHOOK_SECRET` plus `RAZORPAY_ACCOUNT_ID`; PayPal uses `PAYPAL_CLIENT_ID`,
  `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID`, and `PAYPAL_MODE=live`. Register
  `https://<service-host>/api/payments/webhook` for Razorpay's
  `payment_link.paid` event. Tenant seat checkout also requires the explicit
  price and term settings described in `PHASE-7-ENTERPRISE-AUTHORITY.md`.

### Provider resource budgets

AI and render calls use durable per-user/global daily request and token-proxy
budgets, concurrency admission, and a deadline spanning connection and body
reading. Exhausted capacity returns 429 instead of starting more work. Rendering
reserves project artifact capacity before dispatch. Retries use the same budgets.

| Setting suffix | `AI_` default | `RENDER_` default |
| --- | --- | --- |
| `USER_CONCURRENCY` | 2 | 1 |
| `GLOBAL_CONCURRENCY` | 16 | 4 |
| `USER_DAILY_REQUESTS` | 100 | 20 |
| `GLOBAL_DAILY_REQUESTS` | 5,000 | 200 |
| `USER_DAILY_TOKEN_BUDGET` | 250,000 | 200,000 |
| `GLOBAL_DAILY_TOKEN_BUDGET` | 10,000,000 | 10,000,000 |
| `PROVIDER_TIMEOUT_MS` | 30,000 | 120,000 |

`AI_MAX_OUTPUT_TOKENS` defaults to 2,048 (maximum 8,192), and
`RENDER_MAX_OUTPUT_BYTES` defaults to 16 MiB (maximum 64 MiB). Deadlines may not
exceed 300,000 ms. The assistant response body is capped at 256 KiB; provider error
bodies are bounded and not returned verbatim or logged.

These budgets are conservative usage proxies, not monetary invoices. Requests
that reach a provider may incur charges after cancellation or timeout, so their
daily reservations are retained. Set provider-account spending limits as well.
Daily budgets reset on the next UTC day and survive application restarts. Set
`GEMINI_API_KEY` or `IMAGEN_API_KEY` only on the server for live image rendering;
the explicit demo render provider is a local preview and grants no subscription.

### Authentication and browser storage

Startup adds credential epochs, TOTP attempt/replay fields and MFA encryption
without deleting accounts or projects. Password changes and revoke-other-session
operations invalidate pending MFA challenges and other live sessions atomically.
TOTP enrollment now uses authenticated CSRF-protected `POST /api/auth/2fa/setup`.

Sign-out reports success only after server revocation succeeds. The dialog keeps
local copies by default and offers a plaintext recovery ZIP and explicit removal
of account-scoped browser copies. Removal includes unsynchronized work and requires
acknowledgment; it does not delete server projects. Other tabs should be closed
before removal. A fresh, confirmed sign-in can recover an interrupted sign-out;
previously consented removal finishes before local writes resume. Suspended tabs
clear their stale tab-local copies after a removal, preserving newer shared
records. Recovery records carry the removal generation so new session-only drafts
survive reload even when durable storage is full. Private render images use
`private, no-store`.

## Backups and restore

For the hosted Supabase database use the encrypted offsite PostgreSQL export and
isolated restore rehearsal in `OPERATIONS.md`. The following directory/snapshot
procedure is only for a persistent SQLite deployment. It does not back up cloud
records, and Vercel scratch files are never a recovery source.

Set `ADMIN_EMAILS` to the explicit administrator email allowlist for production
backup endpoints. An empty allowlist grants nobody access. The authenticated mail
diagnostic sends only to the caller's own email unless they are allowlisted.

Development demo seeding is disabled by default. It requires
`GROUNDWORK_SEED_DEMO=1`, a loopback development bind and an explicit
`GROUNDWORK_DEMO_PASSWORD` of at least 12 characters with letters and numbers.
The application does not log that password. Existing historical demo accounts
are not deleted or rotated by this change; remove or secure those identities
before deploying an existing database.

Back up the complete persistent data directory, including SQLite sidecar files
(`groundwork.db-wal` and `groundwork.db-shm` when present), and store the exact
`MASTER_KEY` in a separate owner-controlled secret backup. Take a provider disk
snapshot or stop the service before copying the directory so the SQLite backup
is consistent. Do not rely on the repository or an ephemeral filesystem as a
backup.

To restore, stop the service, replace the contents of
`GROUNDWORK_DATA_DIR` with a known-good snapshot, restore the original
`MASTER_KEY`, then start the same release and run the health check. Keep the
database and key from the same backup point; a database without its matching
key cannot be decrypted.

## Post-deploy health check

Render should use `/api/health` as the health-check path. After deployment,
verify the public service returns HTTP 200 and `ok: true`:

```bash
curl -fsS https://<service-host>/api/health
```

If the check fails, inspect startup logs first for invalid production mode,
missing `MASTER_KEY`/`GROUNDWORK_DATA_DIR`, or `PAYMENTS_MODE` before routing traffic
to the release. A successful health check does not verify email delivery, live
checkout, provider billing limits, TLS or external access controls; validate those
in the owner's controlled staging environment.

## Reviewed action pin sources

Pinned revisions were resolved from the official action release commit pages:

- [checkout v4.2.2](https://github.com/actions/checkout/commit/11bd71901bbe5b1630ceea73d27597364c9af683)
- [setup-node v4.4.0](https://github.com/actions/setup-node/commit/49933ea5288caeca8642d1e84afbd3f7d6820020)
- [upload-artifact v4.6.2](https://github.com/actions/upload-artifact/commit/ea165f8d65b6e75b540449e92b4886f43607fa02)

Re-review action updates deliberately. These are verified version pins, not a
claim that an automated dependency/security audit has reviewed upstream code.
References: [Vercel deployment promotion](https://vercel.com/docs/deployments/promoting-a-deployment),
[GitHub secure use](https://docs.github.com/en/actions/reference/security/secure-use).
