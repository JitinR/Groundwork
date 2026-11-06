# Operations and recovery

The Vercel deployment persists application records in Supabase PostgreSQL's
private `groundwork` schema. Vercel `/tmp` and local SQLite backups do not protect
that cloud database. Distinguish configured schedules from completed run evidence
and from full recovery verification.

## Activation record

The canonical application is `https://secure-nexus-xi.vercel.app/`, with production
source on `main` in public repository `jitinraavi/Secure-Nexus`. Main is protected
by the required release gate. Production deploys require successful exact-source
CI. The owner-authorized alert recipient is configured privately; runtime operation
credentials, the daily Vercel check and existing SMTP route are configured privately.

Public external monitoring is activated. Scheduled
[run 39949974048](https://github.com/jitinraavi/Secure-Nexus/actions/runs/39949974048)
and manual [run 39959697259](https://github.com/jitinraavi/Secure-Nexus/actions/runs/39959697259)
succeeded on 23 October 2026. These historical runs do not replace current
freshness checks or prove inbox delivery during an outage.

The approved private recovery repository `jitinraavi/Groundwork-recovery` has an
active schedule with separate backup encryption and restricted database
credentials. A 6 November 2026 recovery run verified a read-only production
export, authenticated restore into disposable PostgreSQL, private encrypted
artifact retention and the durable application recovery record. Check current
archive and restore evidence in the private workflow.
No live database export, restore or SMTP send is part of the ordinary test suite.

Maintain timestamps and workflow URLs for the latest probe, uploaded archive and
successful real restore without credentials or record contents. Mark any control
without successful activation evidence **not activated**. Never upload production
archives to the public source repository's artifacts or silently change visibility.

`node scripts/operational-github-read.mjs /absolute/path/to/repository
owner/repository` retrieves a sanitized, GET-only readiness report using an
existing noninteractive Git Credential Manager login. It lists visibility,
default-branch protection, workflow/CI evidence and configuration **names**;
credentials and variable values remain private. It never changes GitHub settings.

## External monitoring and existing SMTP

`operations-health.yml` runs every 15 minutes, subject to GitHub scheduling delay.
It performs up to three bounded, unauthenticated GET requests to `/api/health`.
It rejects redirects, HTML, oversized bodies, non-200 responses, network failures
and JSON without `ok: true`. This checks the public route and database connection;
it does not prove password login, SMTP inbox delivery, project decryption or saves.

For a new environment, configure GitHub repository variables privately through
Settings → Secrets and variables → Actions; preserve the existing production values:

| Variable | Value |
| --- | --- |
| `OPS_MONITOR_ENABLED` | `true` only after the following configuration is complete |
| `OPS_HEALTH_ORIGIN` | Exact canonical HTTPS origin, no trailing slash |
| `OPS_HEALTH_ALLOWED_ORIGINS` | Same explicit origin; comma-separated additional approved origins if needed |
| `OPS_ALERT_TO` | Owner-authorized inbox `jitinraavi99@gmail.com` |
| `OPS_MAIL_PORT` | `465` or `587` |

Configure separate Actions secrets `OPS_MAIL_HOST`, `OPS_MAIL_USER`,
`OPS_MAIL_PASS`, `OPS_MAIL_FROM` from the existing verified SMTP account. No new
mail provider is needed. Credentials are injected only into the checking step;
they are never printed, added to artifacts, or used by dependency installation.
Alerts require TLS with certificate verification. The workflow opts in to sending
only after three consecutive failures within that run. A sustained outage sends
at most one message per scheduled run; it does not yet deduplicate across runs.
SMTP failure fails the workflow, so enable GitHub failed-workflow notifications
as the independent fallback. No success email is sent.

When `OPS_BACKUP_ENABLED=true`, the same monitor uses its read-only GitHub token
to check for a successful default-branch backup run within 26 hours and a matching
unexpired, nonempty encrypted artifact. Missing/stale evidence fails the check
and uses the same SMTP alert route. This checks uploaded-artifact freshness,
not whether real-data restoration/decryption has been rehearsed.

After configuration changes, dispatch a normal health run and perform an
owner-controlled failure drill against an isolated target. Confirm the failed
run and inbox delivery. GitHub schedules can be delayed or disabled; inspect the last run daily.
Set a freshness alert/process if no completed probe exists for 45 minutes.

## Encrypted offsite PostgreSQL export

`operations-backup.yml` is opt-in, runs only on the default branch of a **private**
repository, and schedules a daily export at 02:41 UTC.

The approved private recovery copy uses `RECOVERY_ENABLED` as its activation gate
and `SOURCE_COMMIT` to identify reviewed tooling. Before each backup it resolves
the current source main commit and requires its successful exact-commit CI. It
also checks backup freshness hourly and reports accepted successful archive/restore
evidence to the protected application operations endpoint. Activate that copy
only after a successful first real archive/restore and artifact verification. The
generic checked-in workflow's configuration is listed below; it remains inactive
in the public source repository.

| Type | Name | Purpose |
| --- | --- | --- |
| Variable | `OPS_BACKUP_ENABLED` | `true` after owner review and credential setup |
| Variable | `BACKUP_ALLOWED_HOST` | Exact copied Session-pooler/direct host and explicit port as represented by the URL |
| Secret | `BACKUP_DATABASE_URL` | Restricted export/runtime login with full-schema SELECT policies, never an administrator URL |
| Secret | `BACKUP_ENCRYPTION_KEY` | New, random, canonical base64 32-byte key, independent of every application key |

Generate the backup key in the owner's password manager/secret store. Preserve
an independent recovery copy there. Never put that key or application
`MASTER_KEY`/`PREVIOUS_MASTER_KEY` in the artifact. Keep the application keys in a
separate owner-controlled recovery vault, labelled with rotation history.
The export process refuses to run when application encryption keys are present.

The existing restricted runtime login can export using the private schema's
`groundwork_runtime` SELECT policies, which grant full row visibility. The tool
uses `--enable-row-security` and does not require or grant BYPASSRLS. It holds a
read-only transaction and gives native `pg_dump` read-only connection options.
Prefer a separate login granted only CONNECT, schema USAGE, SELECT on application
tables/sequences and explicit full-row SELECT policies, without write, CREATE,
role-management, schema-ownership or RLS-bypass privileges. Its SELECT policies
must cover **all** application rows: row-security-aware exports can otherwise
successfully back up a subset. Review row visibility and new tables/sequences
after every migration. Never use a service-role API key or administrator URL.

The export holds a read-only repeatable-read transaction, fingerprints every
table using sorted SHA-256 row hashes and counts, and supplies its exported
snapshot to native `pg_dump --schema=groundwork --format=custom
--enable-row-security --inserts`. INSERT format supports RLS-aware restoration
and trades throughput for compatibility. The database
archive and manifest are separately authenticated and encrypted with AES-256-GCM,
fresh random nonces, and a versioned authenticated header. Only `.gwb` ciphertext
is written. Plaintext lives in bounded process memory; archive input/output is
limited to 256 MiB. Larger datasets require a reviewed streaming design before
raising this limit. Hosted connections verify TLS against the committed public
Supabase CA. Passwords are passed through child environment variables, not CLI
arguments; PostgreSQL output and raw errors are not logged.

The workflow uses PostgreSQL client major version 17; confirm it is compatible
with the source's actual major before activation. An older client refuses newer
servers. GitHub retains each immutable encrypted archive/manifest pair for seven
days. Download requires authenticated repository read access. This is offsite
relative to Supabase, but it is neither immutable regulatory storage nor
protection against an administrator deleting the repository/artifacts. Retention
and Actions usage consume existing GitHub allowances; inspect quota and failures.
No paid service is provisioned. Maintain an additional owner-controlled encrypted
copy if longer retention or repository-loss recovery is required.

The export includes the private application schema's definitions, records,
indexes, policies, constraints and sequence states. It deliberately omits role
passwords/ownership/grants, other schemas, Supabase Storage objects, provider
configuration and external keys. Reapply reviewed application migrations/grants
to a new hosted destination. Never infer a complete Supabase project backup from
this application archive. Recheck scope if attachments move outside PostgreSQL.

## Authenticate and rehearse restoration

Install compatible `pg_dump`/`pg_restore` binaries. Download the encrypted archive
and matching encrypted manifest from the selected Actions run into a private
directory. Supply `BACKUP_ENCRYPTION_KEY` through a private shell/secret injection,
then run:

```sh
npm run backup:verify -- /absolute/private/path/groundwork-TIMESTAMP.gwb
```

Without a target URL this authenticates both envelopes and checks the archive
SHA-256; it reports `restored: false`. Authentication alone is not a restore drill.

For a rehearsal, create a fresh disposable local PostgreSQL instance. Inject
`BACKUP_RESTORE_DATABASE_URL` with a literal loopback IP host and a new database
name beginning `groundwork_restore_`; set `BACKUP_RESTORE_ALLOWED_HOST` to that
exact host/port and `BACKUP_RESTORE_ACK=restore-into-empty-isolated-database`.
Run the same command. It refuses any existing application schema or non-system
relations, authenticates the complete ciphertext **before** executing the archive,
restores in one transaction and compares every table's row count, sorted row hash
and migration versions. It creates only the required NOLOGIN policy role. The
rehearsal needs sufficient local privileges to create that role and schema.

Never restore an untrusted archive: PostgreSQL archives can execute source SQL.
The tool only accepts loopback rehearsal destinations and cannot restore directly
to a production host. Dispose of the local instance after the drill; do not upload
its data directory, traces or plaintext dumps. Record duration, run ID, source
timestamp and result without record contents. Perform a real archived-data drill
monthly and after backup-format/schema changes. Separately verify one encrypted
project can open in an isolated application using its matching key from the
recovery vault. The database comparison deliberately does not access that key.

Production recovery requires explicit owner approval of the actual target,
snapshot and key version. Pause writes, preserve the damaged database, restore to
a **new** hosted database using an administrator-reviewed procedure, reapply
least-privilege roles/grants, verify records and isolated application decryption,
then change runtime connection configuration and release. Keep the previous
database available for investigation. Do not overwrite production using a drill
command, or revert to stale SQLite after new cloud writes.

## Release and routine checks

Follow `RELEASE.md` for exact-commit CI evidence and the active post-CI Vercel release path.
Follow `SLO.md` for SLIs and performance sampling, and `INCIDENTS.md` for ownership,
triage and recovery decisions. Review failed scheduled runs, monitor freshness,
backup freshness (last artifact no older than 26 hours), quota, and the latest
restore evidence daily. A missing artifact or failed notification is actionable.

Sources: [Supabase backups](https://supabase.com/docs/guides/platform/backups),
[PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html),
[pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html),
[artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts),
[GitHub workflow security](https://docs.github.com/en/actions/reference/security/secure-use).
