# Groundwork Design Studio

A deployable, full-stack design studio for interior designers, architects and site engineers:

- **Capture a room** — camera or file upload (PNG/JPEG/WebP/GIF), traced as the canvas backdrop.
- **Design in 3D** — place furniture, change finishes/colours, scale and rotate, paint walls/floors, add curtains (sheer/blackout/roman/panel) on any wall.
- **Ship to CAD & 3D tools** — export DXF (AutoCAD-ready plan with layers), OBJ+MTL (Blender/3ds Max), GLB, and a furniture bill-of-materials CSV.
- **Get paid** — subscription portal (Free / Pro ₹4,999·mo / Studio ₹11,999·yr) with UPI, card and PayPal; demo mode works with zero credentials.
- **Design outside the box** — residential/commercial community and infrastructure concept workspaces with manually entered site coordinates, measured extents and local boundary references. An explicit Google Earth link supports external site inspection; embedded map imagery and survey/CRS accuracy are not provided.
- **Hardened by default** — scrypt password hashing, TOTP 2FA, encrypted-at-rest design data and photos (AES-256-GCM), CSRF, rate limiting, account lockout and a full audit log.
- **Bounded live collaboration** — authenticated owner presence over reconnecting SSE, encrypted collaboration events, comments/issues, snapshots, and optimistic revision conflict checks.

Stack: Node 22 · Express · Supabase PostgreSQL (SQLite local/test fallback) · React 18 · Vite · Tailwind v4 · three.js.

Release 1.2 opens projects in a canvas-first CAD workspace with semantic architectural
objects, model-space face grips, exact dimensions, transactional undo/redo, explicit
electrical/plumbing connectivity and geometry-linked calculations. Existing project
modules remain accessible from the workspace. Read the [CAD workflow and supported
engineering scope](docs/CAD-WORKSPACE.md) before authoring or exchanging models.

Release 1.1 adds shared request limits and circuit breakers, revision-safe saves and restores,
atomic collaboration leases, bounded SSE streams, encrypted render inputs, key rotation,
redacted tracing, SLO metrics, operational alerts and audited feature controls.
The stable API prefix is `/api/v1`; installed clients may continue using `/api`.
Design writes and snapshot restores require the last observed `baseRevision`.
Read [operations](docs/OPERATIONS.md), [recovery](docs/DURABLE-RECOVERY.md), and
[release controls](docs/RELEASE.md) before deploying changes or restoring data.
The [engineering implementation record](docs/ENGINEERING-IMPLEMENTATION.md)
maps all 111 audited topics to source changes, test evidence and remaining
operational verification.

For the product overview, competitor positioning and full verified technology
inventory, read the [project documentation](docs/PROJECT-DOCUMENTATION.md).
A [formatted browser version](docs/PROJECT-DOCUMENTATION.html) and a
[shareable PDF](docs/Groundwork-Project-Documentation.pdf) are also available.

The hosted database setup and verified SQLite-to-PostgreSQL import are described in
[Supabase setup](docs/SUPABASE.md). Existing login, Gmail OTP and encryption remain
in the Groundwork backend. Database credentials never belong in the browser.

---

## Local development

Requirements: Node >= 22.12 (Vite 8; CI uses the maintained Node 22 line).

```bash
npm ci
npm run dev        # API on :4000, Vite app on :5173 (proxies /api)
```

The first server boot generates a random `MASTER_KEY` in `server/.env` (used to derive the vault key that encrypts all project data and photos — keep it safe, it is your data's backstop).

The API lives in `server/`, the client in `client/`.

### Collaboration model

The editor uses a server-authoritative revision protocol rather than a CRDT. Each design write and snapshot restore includes the last revision observed by the client; a stale write receives `409 REVISION_CONFLICT` and is never applied. The client retains local edits for explicit recovery. Authenticated project owners, editors and viewers can subscribe to `/api/collaboration/:projectId/events` via SSE and create encrypted comments/issues. Only project owners and editors can change item status or design data; viewers cannot resolve items. Expiring public share links remain read-only and grant no collaboration membership. SSE payloads contain metadata; project and item content remains encrypted at rest. Local connections receive immediate fanout, while persisted database events support polling/replay across function instances. Optional Redis transport requires separate configuration. Shared subscription reservations bound connection admission; slow streams close and reconnect through the durable cursor.

### Assistant configuration

The first assistant phase is opt-in and server-side. Set `AI_API_KEY` and `AI_MODEL` in `server/.env`; set `AI_BASE_URL` when using an OpenAI-compatible provider other than the default `https://api.openai.com/v1`. The client calls `POST /api/assistant/plan` with the current project context. Without `AI_API_KEY`, the endpoint returns a deterministic configuration-required message and no AI-generated actions.

Assistant output is a validated, non-mutating action plan. Structural and MEP suggestions are preliminary coordination concepts and require review by qualified licensed professionals before use.

## Production build

```bash
npm run build      # builds client then server
npm start          # serves API + built SPA on $PORT (default 4000)
```

Navigate to the app at the served port. In production the session/CSRF cookies use the `Secure` flag, so use HTTPS (Render provides it).

## Deploy to Render

Create a web service with these settings and persistent storage. See
[deployment guide](docs/DEPLOYMENT.md) and [release instructions](docs/RELEASE.md)
for required mail, payment, key and provider-budget configuration. The included
`render.yaml` defines a single authority with required persistent storage.

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Env: `NODE_ENV` | `production` |
| Env: `PAYMENTS_MODE` | `live` (required in production) |
| Env: `MASTER_KEY` | **Required stable base64 32-byte secret**; preserve it across deploys and use the documented previous-key procedure for a planned rotation |
| Env: `GROUNDWORK_DATA_DIR` | `/var/data` on the required persistent disk |

**Persistence:** set `DATABASE_PROVIDER=supabase` and the server-only `DATABASE_URL`
for the hosted PostgreSQL database. Preserve the matching `MASTER_KEY` for encrypted
records. `GROUNDWORK_DATA_DIR` remains required for optional native-job scratch
storage. Local SQLite fallback uses `groundwork.db`, with `DB_PATH` as a directory
override. See [Supabase migration and rollback](docs/SUPABASE.md).

**Payments:** production requires `PAYMENTS_MODE=live`; missing, invalid or demo modes fail startup. Razorpay requires a live `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` and `RAZORPAY_ACCOUNT_ID`. Register `https://<your-app>/api/payments/webhook` for `payment_link.paid`. PayPal requires `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID` and `PAYPAL_MODE=live`. Unconfigured live providers cannot grant demo subscriptions. Demo checkout is available in local development/test.

**Email:** configure SMTP or Resend before onboarding users. For Gmail, run `npm run mail:setup` in a local terminal; it hides app-password entry, verifies authentication and preserves the existing encryption key. See [Gmail OTP setup](docs/GMAIL-OTP.md). Production has no console-mail fallback, OTP response disclosure or OTP payload logging. Local code disclosure requires explicit `GROUNDWORK_DEV_OTP=1` and a loopback-only request/service.

Payments are stored with `status`, provider order id and provider URL. PayPal amounts are collected in USD (converted from the INR plan price); Razorpay Payment Links accept UPI and cards natively.

## Security notes

- **Passwords:** scrypt with per-user random 16-byte salt, N=16384/r=8/p=1. Never logged or returned.
- **At-rest encryption:** AES-256-GCM. The vault key is derived from `MASTER_KEY` via HKDF; each user's blobs use a domain-separated AAD (project data and photos use distinct AADs), so ciphertexts cannot be replayed across resources.
- **Sessions:** random 256-bit tokens stored as SHA-256 hashes, absolute expiry and credential epochs. Password changes/revocation invalidate other active and pending MFA sessions and outstanding email login codes. Cookies use `SameSite=Lax`, `HttpOnly`, and `Secure` in production. Failed logout retains signed-in UI with retry.
- **CSRF:** session-bound tokens protect authenticated mutations. Anonymous JSON authentication and verified provider webhooks have scoped exemptions. MFA setup uses POST with CSRF validation.
- **Rate limiting:** shared database API limit (300 per normalized IP budget per 15 min) before JSON parsing; SSO has a stricter limit. IP budget keys are HMAC pseudonyms. Password, email OTP and TOTP attempts have account/challenge limits. Upload and provider work have independent concurrency/resource budgets.
- **2FA:** TOTP (RFC 6238, SHA-1, 30 s, 6 digits), user-bound encrypted seeds, single-use timesteps, persistent throttling and enforced re-entry on login when enabled.
- **Input:** route schemas, design byte/count/depth limits, bounded multipart parsing and sniffed photo formats (PNG/JPEG/WebP/GIF). Photos allow 25 MiB; workspace files allow 64 MiB; render sources allow 32 MiB. BCF imports use bounded worker inflation. CSP uses Helmet, `frame-ancestors none`, and strict referrer policy.
- **Offline privacy:** sign-out defaults to keeping unsynchronized copies, offers a plaintext recovery ZIP and requires explicit acknowledgment for removal. Retained browser copies and backups are plaintext. Private render images use `private, no-store`.
- **Audit log:** signup/login/2FA/export/payment/project events recorded with IP and user agent; visible in the app (Settings → Audit log) including export history and failed-login attempts.

## Project layout

```
server/src
  config.ts         env, constants, cookie names
  db.ts             asynchronous database adapter and transaction ownership
  postgresDatabase.ts Supabase PostgreSQL pooling, TLS and explicit migrations
  sqliteDatabase.ts local/test SQLite schema bootstrap
  crypto.ts         scrypt, AES-256-GCM, HKDF, random tokens
  totp.ts           TOTP implementation
  validate.ts       Zod schemas (email/password/confirm)
  audit.ts          audit log helper
  security.ts       rate limits, sessions, CSRF middleware
  routes/           auth, secrets, audit, projects (+photo upload), payments, assistant plan
  payments/         plans + demo/razorpay/paypal providers
client/src
  api.ts            typed API client (CSRF header injection)
  editor/Canvas3D.tsx  three.js room editor (drag, selection, GLB export)
  lib/              furniture catalog, DXF/OBJ/CSV exporters, zip/download
  pages/            landing, auth, dashboard, editor, audit, settings, billing, checkout
client/studio.html  architecture studio homepage, built alongside the application
client/studio/      vanilla JavaScript, Three.js scenes and modular studio CSS
render.yaml         single-authority blueprint with required persistent disk
SPEC.md             product specification & open questions
```

## Testing

- Server: `npm run build -w server` (tsc).
- Client: `npm run build -w client` (tsc + vite).
- Automated regression suites: `npm test`; PostgreSQL-compatible API flow: `npm run test:postgres-flow`.
- Isolated read/SSE capacity rehearsal and its limits: [engineering implementation](docs/ENGINEERING-IMPLEMENTATION.md#synthetic-performance-evidence).
- Smoke test the API flow with the built server running (`npm start`): sign up → create project → save design → upload photo → pay (demo) → export → check the audit log.

## Studio homepage and deployment readiness

The public architecture/interiors studio is integrated with the existing
application rather than replacing its authenticated tools. Both HTML entries
ship in the same Vite build. The studio uses local photography and fonts,
centralized design tokens, a Three.js point-scan city, accessible service layouts,
an eight-project gallery and a staged process model. Existing authentication,
dashboard, editor, sharing and billing routes remain application routes.

Run `node scripts/deployment-preflight.mjs --build-only` after building, then
`node scripts/deployment-preflight.mjs --env-file .env --check-build` with your
private production configuration on the target runtime. The helper prints no
configuration values. [DEPLOYMENT.md](docs/DEPLOYMENT.md) covers Docker, Render,
HTTPS/proxy identity, email, payments, backup restoration and offline upgrades.
Production still requires owner-provided infrastructure and provider credentials;
the optional native worker remains explicitly disabled and unverified.
