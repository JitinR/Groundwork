# Native Linux acceptance

On **2 November 2026**, the real Groundwork adapters passed five bounded acceptance groups on the existing **WSL2 Ubuntu 26.04.1 LTS x86_64** installation, using Node 22.22.1. This uses a local Linux installation without a cloud account. It is an acceptance host, not a connected production worker; the public application's native configuration remains disabled.

## Reproduce

Use a dedicated x86_64 Ubuntu environment with root privileges for namespace/chroot setup and child identity transition. These scripts build under `/opt/groundwork-native-acceptance`; they never start the web server, load application environment files, connect to a database or enable a queue worker.

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends build-essential gfortran cmake curl ca-certificates xz-utils pkg-config tcl-dev tk-dev libblas-dev liblapack-dev libeigen3-dev libhdf5-dev zlib1g-dev python3 python3-dev util-linux
npm ci
npm run build -w server
node --import tsx scripts/generate-native-validation-fixtures.mjs
sudo bash scripts/build-native-acceptance.sh
sudo env GROUNDWORK_NATIVE_NODE_PATH="$(command -v node)" bash scripts/run-native-acceptance.sh
```

Node 22 must be installed first. On WSL when dependencies were installed with Windows Node, generate the fixture and build TypeScript on Windows, then run the two shell scripts inside Ubuntu against the shared checkout. Do not reuse Windows native npm binaries as Linux executables. The launcher accepts an absolute `GROUNDWORK_NATIVE_NODE_PATH` for standalone Node installations, including CI's setup-node tool cache.

Source build concurrency defaults to two and is bounded to one through four by `GROUNDWORK_NATIVE_BUILD_JOBS`. Build and acceptance runs share an exclusive lock. Source downloads use HTTPS and exact SHA-256 checks:

| Runtime | Official source | SHA-256 |
|---|---|---|
| LibreDWG 0.13.4 | `https://ftp.gnu.org/gnu/libredwg/libredwg-0.13.4.tar.xz` | `7e153ea4dac4cbf3dc9c50b9ef7a5604e09cdd4c5520bcf8017877bbe1422cd5` |
| OpenSees 3.8.0 | `https://codeload.github.com/OpenSees/OpenSees/tar.gz/refs/tags/v3.8.0` | `395d89f97ad0fe2a857e31b045c96badf23ad19ba8ce38f21c5a5d7891091810` |

Binary hashes depend on the platform/toolchain and are recorded with each run, rather than assumed to match across Ubuntu releases. LibreDWG is built with C11 semantics for newer compilers. Python development headers are needed by the upstream OpenSees build even though acceptance runs its Tcl CLI.

## Executed contract

| Acceptance group | Verified behavior |
|---|---|
| Confinement and limits | Private network/mount/PID namespaces; no active network interfaces or host homes/Windows mounts; child UID/GID 10001, zero effective capabilities; the child cannot read PID 1 or the Node supervisor's environment. Kernel probes confirm both soft and hard address-space, CPU, file-size, process and open-file limits. |
| OpenSees cantilever | Axial, transverse and end-moment displacements/rotations match closed forms; global force/moment equilibrium holds. Runtime 3.8.0, parsed output fingerprints and `computed-unvalidated` provenance are checked. |
| OpenSees simply supported beam | Uniform-load support slopes and reactions match the independent linear-elastic solution. |
| LibreDWG round trip | The application's actual R2000 DXF exporter creates a synthetic room and an authored 10 m line. DXF → DWG → DXF preserves its known endpoints, physical length and millimetre unit declaration. The input fingerprint and R2000 `AC1015` output header are checked. |
| Rejection and cancellation | Uploaded Tcl, an unstable model and a pre-cancelled job produce no accepted result. Configuration with a missing isolation acknowledgement or unsupported solver version is unavailable. |

The resource envelope matches the adapter: 512 MiB virtual address space, 60 CPU seconds, 32 MiB file size, 32 processes, 64 open files and a 90-second job wall limit. This acceptance does not claim to have forced every limit or cancellation race to exhaustion.

The launcher creates a temporary minimal filesystem with only the trusted adapter modules, Zod, required executable/library files, Tcl runtime, synthetic fixtures and required Ubuntu externalized Node builtin sources. It clears the supervisor environment before entering the chroot. Scratch/evidence directories remain private; runtime files remain root-owned. Temporary files are removed from the validated invocation-specific path after the namespace exits. Positive-case failures emit only bounded synthetic diagnostics and still fail acceptance.

Evidence is written to `artifacts/native-acceptance/report.json`, `binary-sha256.txt`, `source.dxf` and `source.json`. The report includes the distribution, Node/runtime versions, binary hashes, source fingerprint, measured kernel limits and check results. CI's `Native runtime acceptance` workflow builds from the same pinned sources on Ubuntu 24.04, runs on relevant PRs/main changes or manual dispatch, uses no application secrets and retains synthetic evidence for 14 days. It is a validation job, not production hosting.

## Production boundary

These results validate the declared native subset on the tested host. They do not establish arbitrary DWG fidelity, every OpenSees feature, national-code compliance, professional engineering approval, live job submission/download, multi-tenant worker confinement or operational uptime.

`Dockerfile.worker` and the disabled Compose scaffold remain disabled. A production worker still needs a dedicated durable-job process, per-job confinement appropriate to concurrent untrusted inputs, scoped queue/storage access, lifecycle ownership and a release gate bound to its deployed commit. Do not set an isolation acknowledgement or enable native jobs merely because this acceptance passed. The existing web release gate does not enforce this separate workflow; a native worker release must require its own successful runtime acceptance.
