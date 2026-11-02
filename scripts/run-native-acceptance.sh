#!/usr/bin/env bash
# Create an ephemeral minimal rootfs; no application secrets or project data enter it.
set -euo pipefail
umask 022
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(uname -s) = Linux && $(uname -m) = x86_64 && $(id -u) = 0 ]] || { echo 'Requires root on x86_64 Linux.' >&2; exit 1; }
chrootbinary=$(command -v chroot)
[[ $chrootbinary = /* && -x $chrootbinary ]] || { echo 'Requires the system chroot executable.' >&2; exit 1; }
repo=$(cd "$(dirname "$0")/.." && pwd -P)
root=/opt/groundwork-native-acceptance
mkdir -p "$root"
exec 9>"$root/build.lock"
flock -n 9 || { echo 'Another native build or acceptance run is active.' >&2; exit 1; }
nodebinary=${GROUNDWORK_NATIVE_NODE_PATH:-/usr/bin/node}
[[ $nodebinary = /* && -x $nodebinary ]] || { echo 'Native acceptance needs an absolute Node executable.' >&2; exit 1; }
[[ -x $root/runtime/bin/OpenSees && -f $repo/server/dist/nativeAdapters.js && -d $repo/node_modules/zod && -f $repo/artifacts/native-acceptance/source.dxf && -f $repo/artifacts/native-acceptance/source.json ]] || { echo 'Build the server/runtimes and generate native validation fixtures first.' >&2; exit 1; }
mkdir -p "$root" "$repo/artifacts/native-acceptance"
rootfs=$(mktemp -d "$root/rootfs.XXXXXXXX")
# Native children need to traverse the synthetic root after chroot/UID drop.
# All writable job/evidence paths remain private below it.
chmod 0755 "$rootfs"
cleanup() {
  # Only remove this invocation's verified, dedicated ephemeral directory.
  case $(realpath -m "$rootfs") in "$root"/rootfs.*) rm -rf -- "$rootfs" ;; *) echo 'Refusing unexpected cleanup path' >&2 ;; esac
}
trap cleanup EXIT
mkdir -p "$rootfs"/{app/node_modules,runtime/bin,jobs,evidence,proc,dev,etc,tmp}
chmod 0700 "$rootfs/jobs" "$rootfs/evidence" "$rootfs/tmp"
cp "$repo/server/dist/nativeAdapters.js" "$repo/server/dist/engineeringBasis.js" "$rootfs/app/"
cp "$repo/scripts/native-runtime-acceptance.mjs" "$rootfs/app/"
cp -R "$repo/node_modules/zod" "$rootfs/app/node_modules/"
cp "$root/runtime/binary-sha256.txt" "$rootfs/runtime/"
cp -L /etc/os-release "$rootfs/etc/os-release"
cp "$repo/artifacts/native-acceptance/source.dxf" "$repo/artifacts/native-acceptance/source.json" "$rootfs/app/"
printf '{"type":"module"}\n' > "$rootfs/app/package.json"
printf 'root:x:0:0:root:/:/nonexistent\nnative:x:10001:10001:native:/jobs:/nonexistent\n' > "$rootfs/etc/passwd"
printf 'root:x:0:\nnative:x:10001:\n' > "$rootfs/etc/group"
python3 - "$rootfs" "$root/runtime" "$nodebinary" <<'PY'
import os, pathlib, re, shutil, subprocess, sys
dest, runtime = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
queue = [(pathlib.Path(sys.argv[3]), '/usr/bin/node'), (pathlib.Path('/usr/bin/prlimit'), '/usr/bin/prlimit')]
queue += [(runtime / 'bin' / name, '/runtime/bin/' + name) for name in ('OpenSees', 'dwg2dxf', 'dxf2dwg')]
copied = set()
while queue:
    source, target = queue.pop()
    if target in copied: continue
    copied.add(target)
    path = dest / target.lstrip('/')
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, path, follow_symlinks=True)
    os.chmod(path, os.stat(source).st_mode & 0o777 & ~0o022)
    result = subprocess.run(['ldd', str(source)], capture_output=True, text=True, check=True)
    if 'not found' in result.stdout: raise RuntimeError(result.stdout)
    for library in re.findall(r'(/[^\s()]+)', result.stdout): queue.append((pathlib.Path(library), library))
for source in ('/usr/share/tcltk/tcl8.6',):
    shutil.copytree(source, dest / source.lstrip('/'), dirs_exist_ok=True)
# Debian/Ubuntu may externalize these Node builtins. Official standalone Node
# embeds them; copy only the known system source files when present.
for source in ('/usr/share/nodejs/acorn-walk/dist/walk.js', '/usr/share/nodejs/acorn/dist/acorn.js',
               '/usr/share/nodejs/cjs-module-lexer/dist/lexer.js', '/usr/share/nodejs/cjs-module-lexer/lexer.js',
               '/usr/share/nodejs/minimatch/dist/cjs/index.bundle.js', '/usr/share/nodejs/undici/undici-fetch.js'):
    if pathlib.Path(source).is_file():
        target = dest / source.lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
PY
mknod -m 0666 "$rootfs/dev/null" c 1 3
mknod -m 0666 "$rootfs/dev/urandom" c 1 9
hostnet=$(readlink /proc/self/ns/net)
hostmnt=$(readlink /proc/self/ns/mnt)
hostpid=$(readlink /proc/self/ns/pid)
# Confinement precedes setting the acknowledgement in the acceptance process.
# No bind mounts, credentials, host homes, Windows drives, network or queue access.
unshare --net --mount --pid --fork /bin/bash -c '
  set -euo pipefail
  mount --make-rprivate /
  mount -t proc proc "$1/proc" -o nosuid,nodev,noexec,hidepid=2
  trap '\''umount "$1/proc"'\'' EXIT
  env -i PATH=/usr/bin:/bin "$5" "$1" /usr/bin/node /app/native-runtime-acceptance.mjs "$2" "$3" "$4"
' groundwork-native "$rootfs" "$hostnet" "$hostmnt" "$hostpid" "$chrootbinary"
cp "$rootfs/evidence/report.json" "$repo/artifacts/native-acceptance/report.json"
cp "$root/runtime/binary-sha256.txt" "$repo/artifacts/native-acceptance/binary-sha256.txt"
echo 'Native acceptance evidence: artifacts/native-acceptance/report.json'
