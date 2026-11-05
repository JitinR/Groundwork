# Integrated Groundwork deployment

For a personal non-commercial demo on Vercel Hobby, use the dedicated
[Vercel deployment guide](VERCEL.md). It documents the serverless API entry,
Supabase and Gmail settings, smaller request limits and disabled background jobs.

Hosted deployments use **Supabase PostgreSQL**. Follow [SUPABASE.md](SUPABASE.md)
for the dedicated runtime role, private schema, TLS certificate, one-time data
import and rollback. Configure `DATABASE_PROVIDER=supabase` and server-only
`DATABASE_URL`. SQLite remains a local/test fallback; SQLite snapshot instructions
below apply only to that mode.

The public studio and the existing design application ship from one client build
and one authoritative API. The studio entry is `client/studio.html`; the existing
application entry remains `client/index.html`. This preserves login, dashboard,
editor, billing, project sharing, and account-scoped offline data. Keep the studio
assets under `client/public/studio-assets` to avoid collisions with application
assets. The root studio route must be served before the application fallback.

## Build and verify

Use Node 22.12 or newer; CI and the Render blueprint select the maintained Node 22 line.

```sh
npm ci
npm run lint
npm run build
node scripts/deployment-preflight.mjs --build-only
npm run test -w server
npm run test -w client
```

The build check verifies both client HTML entries and the server entry points.
It does not provision secrets, create storage, contact providers, or certify a
deployed environment. Before starting production, configure owner-controlled
values using `.env.production.example` and run:

```sh
node scripts/deployment-preflight.mjs --env-file .env --check-build
node --env-file=.env --disable-warning=ExperimentalWarning server/dist/index.js
```

The helper never prints environment values. It checks Node compatibility,
production mode, encryption-key format, writable storage, mail configuration,
authority topology, payment mode and any configured payment credentials.
Environment files must remain outside version control; platform secret stores
are preferred. A passing preflight is configuration validation, not a live
delivery, payment, TLS, or disaster-recovery test.

## Single authority and persistent storage

The provided recipes run one authority in `direct` gateway mode. Mount persistent
storage at `GROUNDWORK_DATA_DIR`, preserve its ownership for the runtime user, and
preserve the matching stable base64-encoded 32-byte `MASTER_KEY`. Never generate a
new key for each release. Retain previous keys and matching backups when rotating
keys; see `RELEASE.md`. Independent SQLite copies must not be scaled as a shared
database. Multi-host authenticated gateways use `CENTRAL-API-AUTHORITY.md` and
require separate health-check and secret provisioning.

In SQLite mode, automated database snapshots stay on the same data disk. Copy backups to an
owner-controlled off-host destination and test restoration with the matching
encryption keys before accepting production data. The application does not
configure that external backup service for you.

## HTTPS, proxy identity and mail

Production cookies require HTTPS. Set `PUBLIC_APP_ORIGIN` to the public HTTPS
origin, without a path/query. Configure `GROUNDWORK_TRUSTED_PROXY_IPS` only with
the exact immediate proxy addresses actually used by your deployment. Empty
means forwarded identity is not trusted. Verify that two real clients receive
independent rate-limit identities after proxy setup; never use wildcard trust.

Configure `MAIL_PROVIDER=smtp` with host, port, user, password and verified
`MAIL_FROM`, or select `resend` with `RESEND_API_KEY` and a verified sender.
For Gmail SMTP, use a Google app password and the private setup command described
in [GMAIL-OTP.md](GMAIL-OTP.md). `npm run mail:verify` checks Gmail authentication
without sending an email. Restart the API after changing mail configuration.
Production has no console-mail fallback. Complete a real registration, email
verification and password reset to verify delivery before onboarding users.
SMTP uses TLS in production; use `MAIL_SECURE=true` for implicit TLS or the
configured provider's STARTTLS port with `MAIL_SECURE=false`.

## Docker Compose

Create a private root `.env` from `.env.production.example` and provision its
required values. Compose maps the app port to loopback by default, ready for your
separate HTTPS reverse proxy. The container runs as the unprivileged `node` user.

```sh
docker compose build app
docker compose run --rm --no-deps app node scripts/deployment-preflight.mjs --check-build
docker compose up -d app
docker compose ps
```

The runtime automatically runs preflight before starting. It uses the named data
volume across container recreation. A host reverse proxy reaches the published
loopback port; a proxy in another container requires an explicitly configured
shared network. Do not expose the raw HTTP port as your public HTTPS endpoint.
Do not run `docker compose config` in logs that could expose resolved secrets.

## Render

`render.yaml` defines a Node service with a required persistent disk. Connect the
repository, provision `MASTER_KEY`, public origin, actual proxy identity and
verified mail settings in the platform, and configure optional payment/AI keys
there. The build command compiles both entries and checks their output. The
start command checks production configuration before launching. Keep the
platform-provided `PORT`; the blueprint does not overwrite it. The required
disk and service have provider costs; this is not a free ephemeral deployment.

## Payments and optional providers

`PAYMENTS_MODE=live` is mandatory in production. Without a configured live
provider, checkout remains unavailable; no demo entitlement is granted.
Razorpay needs a live key, secret, webhook secret and `RAZORPAY_ACCOUNT_ID`.
Register `/api/payments/webhook` for `payment_link.paid` and verify a signed live
callback. PayPal needs its client ID, client secret, merchant ID and
`PAYPAL_MODE=live`. Tenant seats additionally require an explicit integer
`ORGANIZATION_SEAT_PRICE_INR_MINOR` (100–100000000 paise) and
`ORGANIZATION_SEAT_TERM_DAYS` (1–365). Pricing is an owner business decision.

Optional assistant calls use server-side `AI_API_KEY` and `AI_MODEL`. Image
rendering uses `GEMINI_API_KEY` or `IMAGEN_API_KEY`. Keep unconfigured features
honestly unavailable. Studio contact details, imagery and conceptual project
copy require the owner's content review before launch. Newsletter collection
must remain disabled until a real confirmed-subscription endpoint is configured.

## Offline shell migration and acceptance

The application offline worker includes the verified studio document and its
public assets, and selects that document for `/` while retaining the verified
application entry for application routes. API responses are never cached. Existing
controlled editor tabs may retain their prior immutable worker until all tabs
using it close. Save or export pending edits before closing those tabs; do not
force-clear browser databases or reload an unsaved editor to activate a release.

Check a fresh browser and an upgraded existing installation: root studio, local
assets, `/login`, sign-up and reset delivery, authenticated `/dashboard`, project
save/reload, editor navigation, logout, expected `/api/health`, TLS/cookies, mobile
layout and reduced motion. Verify that an offline application navigation still
opens the cached application rather than the studio. Review logs and perform a
backup restoration test. Record the release commit and rollback backup.

## Native worker status

The pinned adapters now have executable, synthetic Linux runtime acceptance.
See [Native Linux acceptance](NATIVE-LINUX-ACCEPTANCE.md) for the source hashes,
isolation model, actual DWG/OpenSees reference results and reproduction commands.
This verification is separate from connecting or releasing a live queue worker.

`Dockerfile.worker` and the `native-worker-unverified` Compose profile are
explicitly disabled scaffolding and are not a supported production worker.
They do not start a second web authority. Do not enable the profile as an
assumption that confinement works. The current native adapter requires pinned
LibreDWG/OpenSees binaries, a distinct UID/GID, privileged identity transition
through a separately reviewed launcher, constrained filesystem/network access,
and a dedicated durable-job entry point. Those operations are not validated by
the web build. Keep `NATIVE_WORKER_ENABLED=false` and
`NATIVE_ISOLATION_ACKNOWLEDGED=false` on the HTTP authority.
Running the web application as root is not a solution to these prerequisites.
HTTP authorities enforce that restriction by rejecting native enablement before
canonical startup loads database/key configuration; the HTTP server no longer
imports or starts the native queue worker. The dedicated client uses a scoped
HTTPS authority transport and a separate secret-free local executor. New remote
registration is independently disabled by default; a registration indicates
configured scope, not worker health or native acceptance. See
[the worker boundary](NATIVE-WORKER-BOUNDARY.md) and
[native worker deployment](NATIVE-WORKER-DEPLOYMENT.md) for the staged Linux
service, synthetic acceptance and remaining live release requirements.
