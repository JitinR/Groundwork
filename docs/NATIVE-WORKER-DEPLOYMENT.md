# Dedicated native worker deployment

Updated 5 November 2026. The web release keeps native processing disabled. These tools stage and run foreground Linux processes; they do not provision a cloud account, install a daemon, change global cgroup delegation, create users or enable the production queue. The legacy Docker/Compose worker exits with status 78.

## Required host and release

Use a dedicated, maintained x86_64 Linux host with root administration, cgroup v2 with `cpu`, `memory` and `pids` already delegated to a private parent, mount/network/PID/IPC/UTS namespace support, Python 3, util-linux (`unshare`, `mount`, `setpriv`, `prlimit`), Node 22 and CA certificates. UID/GID 10001 and 10002 must be reserved for native children and the network client. No other application may run under those IDs. Synthetic authority acceptance also reserves 10003. An always-on host, service owner, patching, storage budget, restart policy and alerts are required for a live service. A sleeping desktop or a successful CI job is not that service.

Build and review an exact commit with locked dependencies. Run `npm ci`, `npm run build -w server` and `node --import tsx scripts/generate-native-validation-fixtures.mjs`. Follow [pinned Linux runtime acceptance](NATIVE-LINUX-ACCEPTANCE.md) to build LibreDWG 0.13.4 and OpenSees 3.8.0, verify their source/binary hashes and test the direct adapters. Do not substitute distribution packages or an arbitrary executable path for the accepted runtime.

The new executor acceptance is separate:

```sh
sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  /usr/bin/python3 -I -S scripts/run-native-worker-acceptance.py \
  --repo /absolute/reviewed/checkout \
  --runtime /opt/groundwork-native-acceptance/runtime \
  --node /absolute/root-owned/node \
  --cgroup-parent /sys/fs/cgroup/delegated-native-parent --with-authority
```

The parent must already expose all three controllers in `cgroup.subtree_control`. Acceptance enables controllers only in its own temporary child and refuses to execute without confinement. With `--with-authority`, it generates short-lived TLS credentials with OpenSSL, starts the real API and a temporary SQLite database on loopback, and exercises the sealed worker through submission, publication and authorized download. The synthetic API's UID 10003 needs read access to the compiled checkout and installed dependencies. Results and source/bundle fingerprints are saved under `artifacts/native-worker-acceptance/`. Unit/API transport tests run with `npm test` and `npm run test:native-worker:postgres`. The PostgreSQL engine test uses the restricted runtime role.

## Stage installations

Run the staging scripts as root from the reviewed checkout, supplying a new dedicated version directory. Source files must be regular, have no group/world write permission, links, special modes or file capabilities. On Windows/WSL, copy the allowlisted build inputs into a protected native-Linux filesystem first; permissive DrvFS modes are refused. Never copy a complete application checkout or `.env` into a worker installation.

```sh
sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  GROUNDWORK_NATIVE_NODE_PATH=/absolute/root-owned/node \
  /usr/bin/bash scripts/stage-native-executor.sh \
  /opt/groundwork-native-executor-RELEASE /opt/groundwork-native-acceptance/runtime

sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  GROUNDWORK_NATIVE_NODE_PATH=/absolute/root-owned/node \
  /usr/bin/bash scripts/stage-native-worker.sh /opt/groundwork-native-worker-RELEASE
```

Staging records a root-owned hash/mode/size manifest. The executor bundle contains the adapter, its validation dependency and pinned native runtimes and libraries. The network bundle contains five worker modules, Node and its libraries, CA and DNS files, and a token mount placeholder. Each launcher rechecks its manifest. Stage a new version for each release. The staging-only `GROUNDWORK_NATIVE_CA_BUNDLE` and `GROUNDWORK_NATIVE_RESOLVER_FILE` overrides accept reviewed root-owned files. Use a protected resolver copy if `/etc/resolv.conf` points through a writable directory. The runtime enforces TLS validation and pins requests to the configured HTTPS origin.

## Authority configuration and credentials

Before enabling remote registration, apply migration `20261104191702_native_worker_transport.sql` through the existing administrator migration procedure. Both staging tables live in the private `groundwork` schema, have RLS/runtime policies and are not granted to anonymous/authenticated API roles. The baseline web schema remains compatible while this optional feature is disabled. Do not use the runtime database role for DDL.

Generate a unique random bootstrap token (at least 32 random bytes, base64url encoded). Keep it in a root-owned single-link regular file, mode 0400, below a protected root-owned directory; never place it in command arguments, Git, application `.env`, logs or CI artifacts. Store only its SHA-256 fingerprint on the authority. Registration example:

```json
[{"id":"pilot-worker-01","tokenSha256":"<64 lower-case hex>","projectIds":["<one explicit pilot project ID>"],"kinds":["dxf-to-dwg"]}]
```

Set `NATIVE_REMOTE_WORKER_ENABLED=true` and `NATIVE_REMOTE_WORKERS_JSON` only after migration and pilot acceptance. Limit the project/kind list to the intended pilot. Keep `NATIVE_WORKER_ENABLED=false` and `NATIVE_ISOLATION_ACKNOWLEDGED=false` on the HTTP authority. The independent runtime `native` feature flag defaults off; configuring a worker does not enable that flag and is not a health check. Enable a narrow pilot only after the complete deployed path is accepted.

Deleting a registration or changing its token fingerprint revokes subsequent operations, including active grants; the worker aborts when renewal is refused. Restart the dedicated client with its new private token. Cancel queued pilot jobs before withdrawing a worker permanently, or retain a replacement with the same explicit scope. Never grant database or vault access to solve transport failures.

## Foreground service wiring

Create a short protected socket directory, root-owned mode 0750 with group 10002, for example `/run/groundwork-native`. Do not use a shared writable `/tmp` pathname. Supply a private delegated cgroup parent for attempts; only the broker may administer it.

```sh
sudo env -i /usr/bin/python3 -I -S \
  /opt/groundwork-native-executor-RELEASE/native-executor-broker.py \
  --bundle /opt/groundwork-native-executor-RELEASE/bundle \
  --manifest /opt/groundwork-native-executor-RELEASE/bundle-manifest.json \
  --state-root /opt/groundwork-native-executor-RELEASE/state \
  --socket /run/groundwork-native/executor.sock \
  --cgroup-root /sys/fs/cgroup/delegated-native-parent
```

After the broker is listening, start the separately staged client:

```sh
sudo env -i /usr/bin/python3 -I -S \
  /opt/groundwork-native-worker-RELEASE/native-worker-launcher.py \
  --installation /opt/groundwork-native-worker-RELEASE \
  --token-file /etc/groundwork-native/worker-token \
  --socket-directory /run/groundwork-native \
  --authority-origin https://secure-nexus-xi.vercel.app \
  --worker-id pilot-worker-01 --kinds dxf-to-dwg
```

The launcher mounts a read-only sealed client filesystem, a private credential and the local socket, then drops to 10002 with no capabilities and no-new-privileges. It retains network access for HTTPS; the code pins requests to the configured origin and rejects redirects. An OS-level outbound firewall allowlist is an additional host control and is not created by these scripts. The client probes the executor before claiming work. The broker opens no TCP listener and receives no bootstrap token, project/user identity, grant, database or provider secret.

Run these commands under a reviewed Linux supervisor. Stop the network client before the broker, permit a bounded graceful shutdown, and use a process/cgroup kill as fallback. Monitor fixed diagnostic codes, queue age, failure rates, last successful acceptance and disk/cgroup pressure. The broker serializes work. A cleanup failure terminates it and preserves the affected private scratch for administrator investigation; do not blindly delete it or automatically restart around that refusal. Set host filesystem quotas for installations/scratch; per-process file limits do not impose a total disk quota.

## Limits and release acceptance

Per attempt: fresh filesystem and five namespaces, no active network interface, native UID 10001, 512 MiB aggregate cgroup memory, no swap, 32 tasks, one CPU of bandwidth and a 130-second overall deadline. The native process also has address-space, CPU-time, file-size, process and descriptor limits. CPU bandwidth is a rate, not an aggregate CPU-seconds budget. Native inputs and aggregate outputs are limited to 32 MiB and eight artifacts. The authority rechecks lease/access and publishes atomically; ambiguous mutation acknowledgements are not automatically retried.

Before enabling production, record the deployed API/worker/native bundle hashes and complete real submission → scoped claim → chunk transfer → native execution → encrypted staging → publication → authorized download for conversion and solver jobs. Check cancellation during execution, credential/role revocation, stale attempts, worker restart, grant expiration, another tenant and restoration. Use synthetic pilot projects; keep original drawings. Test representative maximum-size inputs and cross-region latency: the current authority decrypts a complete source artifact for each input chunk, and final publication is one bounded transaction. These paths are correct in bounded fixtures but do not establish maximum-load performance.

Native results remain `computed-unvalidated`. The supported planar elastic/static subset and limited R2000 conversion are not general BIM/structural analysis or national-code certification. Qualified AEC review, receiving-tool checks and project-specific acceptance remain necessary before professional reliance.
