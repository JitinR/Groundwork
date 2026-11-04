# Native worker boundary

Updated 4 November 2026. Native jobs remain unavailable on the supported web deployment. This document records the remaining architecture requirement, not an enabled service.

## Implemented boundary and lifecycle fixes

- Canonical API startup rejects native-worker enablement before storage/key initialization. The HTTP server no longer imports or starts `nativeJobWorker`.
- `nativeWorkerLoop` has no config, database, HTTP, filesystem or provider imports. An injected adapter supplies initialization, claiming, renewal and execution.
- Explicit lease checks and periodic heartbeats share one outstanding renewal. Lease loss or renewal failure aborts execution. Stop cancels timers, aborts active execution, prevents another claim and awaits outstanding initialization/claim/renewal/execution work. Repeated stop calls share one promise.
- The retained database-backed adapter still reauthorizes submitting sessions and project access. Atomic publication remains fenced by the current lease. These guarantees are computation/publication fences, not exactly-once execution.

Ten targeted regressions cover the API boundary and lifecycle, including a startup subprocess that proves storage is not created, renewal/cleanup barriers, late claim completion, cancellation and recovery from callback failures.

## Required service architecture before enablement

| Priority | Component | Authority and acceptance requirement |
|---|---|---|
| High | Unprivileged networked worker | Use a scoped transport adapter for the lifecycle. Do not import server config, `server/.env`, workspace-vault keys, database connections or provider credentials. No public HTTP listener or root identity. |
| High | Scoped authority transport | Provision project/kind-scoped bootstrap access and lease-bound expiring grants. Reauthorize current submitting identity/access at claim, renew and publication; enforce grant expiry/revocation, hashes, budgets and current attempt. Never disclose a submitting session ID to the worker. Preserve atomic output publication. |
| High | Secret-free per-job executor | A narrowly administered launcher receives only one validated input. Create separate filesystem/network/PID confinement per attempt, pin binaries/libraries, drop privileges and enforce resource/cancellation/output limits. It receives no queue/database/key/provider credentials. |
| High | Deployment and live acceptance | Bind worker release to its exact source and native acceptance. Run actual queued conversion/solver fixtures through submission, lease, execution, publication and authorized download; test cancellation, stale grants, permission loss and attempt/tenant isolation. Establish host/lifecycle ownership and recovery monitoring. |

The current `nativeJobWorker` imports database/workspace configuration and the direct native adapter needs ownership changes plus a distinct UID/GID. Merely running that module in a second Node process, or making it root, does not meet this boundary. Its retained supervisor adapter is not a production entry point. The Linux acceptance rootfs deliberately has no queue or application credentials and validates a different, bounded execution scope.

No cloud account, always-on worker, production credentials or public endpoint was provisioned by this change. Keep the disabled Docker/Compose scaffolds and web flags disabled until the service above exists and passes acceptance.
