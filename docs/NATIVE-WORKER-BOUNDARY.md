# Native worker boundary

Updated 5 November 2026. Production native processing remains disabled. This branch supplies the dedicated client, scoped authority transport and local executor; synthetic acceptance does not establish an always-on production service.

## Separation of authority

| Process | Identity and access | Excluded authority |
|---|---|---|
| Web API | Existing application database, vault keys and user authorization | Never executes native binaries or starts a native worker; direct native enablement fails before storage initialization |
| Dedicated network worker | UID/GID 10002, zero capabilities, no-new-privileges, sealed filesystem; fixed HTTPS authority and a project/kind-scoped bootstrap token | No database, master key, provider credentials, user session, application config, native binary or public listener |
| Local broker | Root-owned, environment cleared; a single pathname Unix socket authenticated with SO_PEERCRED; verified sealed runtime and delegated cgroup | No TCP listener, authority token, user session, database, key or provider environment |
| Per-attempt supervisor/native child | Fresh mount/network/PID/IPC/UTS namespaces and chroot; supervisor has only CHOWN/DAC_OVERRIDE/KILL/SETGID/SETUID; native child UID/GID 10001, no capabilities | No network interfaces, host homes/drives, application files, queue credentials or access to supervisor control files |

The broker is privileged trusted code and the Linux kernel remains a shared trust boundary. Chroot and namespaces do not establish virtual-machine isolation. Keep the host patched, dedicated and administered; do not run the web authority as root.

## Transport and publication

All worker operations are authenticated POSTs under `/api/native-worker/v1`. Browser cookies/origins, redirects and automatic mutation retries are refused. Valid machine requests have a separate bounded rate budget; credentials do not authorize other application APIs.

Registration contains a worker ID, SHA-256 token fingerprint, explicit project IDs and job kinds. The worker receives a ten-minute HMAC grant bound to one worker/job/project/source/kind/attempt, without the submitting actor or session. Every operation checks current registration, grant expiry, durable lease, submitting session credential version, access and cancellation. Scope filtering happens before queue selection.

Inputs and outputs use 256 KiB chunks, 32 MiB input and aggregate output budgets, and at most eight output files. Staged chunks are AES-GCM encrypted with attempt/metadata/offset/hash associated data. Exact retransmission is idempotent; gaps, mismatched metadata and conflicting content are refused. Completion reassembles and verifies hashes and source-bound summaries before the existing atomic artifact/state publication transaction. Lease fencing prevents stale publication; execution is not exactly once.

The lifecycle serializes renewals, aborts execution on lease loss and waits for outstanding work at stop. Client cancellation closes the executor socket; the broker kills the complete attempt cgroup, waits for it to empty and removes only that attempt's private scratch. Cleanup failure stops the broker and quarantines scratch.

## Bounded evidence

The real Linux broker passed confinement, actual LibreDWG round trip of an authored 10 m line, OpenSees cantilever closed forms and equilibrium, uploaded-Tcl rejection, and active cancellation/cgroup/scratch cleanup. These are executable synthetic cases, not arbitrary DWG fidelity, all structural methods, national-code assessment or production workload acceptance.

SQLite and PostgreSQL transport tests exercise real API claim/chunk/publication/download paths, cancellation, credential revocation, scope/expiry/stale attempts, tampered staging, budgets and machine/browser separation. Their executor fixture is synthetic; those transport tests alone do not validate native computation.

See [deployment and acceptance](NATIVE-WORKER-DEPLOYMENT.md) for reproduction and remaining production requirements. No production registration, database migration, host service or native feature flag is enabled automatically.
