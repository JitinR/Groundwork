#!/usr/bin/env bash
# Stage a sealed executor installation only. No accounts, services, network
# listener, application environment, queue configuration or cgroup delegation.
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(uname -s) = Linux && $(uname -m) = x86_64 && $(id -u) = 0 && $# -le 2 ]] || { echo 'Requires root on x86_64 Linux and at most install/runtime paths.' >&2; exit 78; }
repo=$(cd "$(dirname "$0")/.." && pwd -P)
destination=${1:-/opt/groundwork-native-executor}
runtime=${2:-/opt/groundwork-native-acceptance/runtime}
nodebinary=${GROUNDWORK_NATIVE_NODE_PATH:-/usr/bin/node}
python3 -I -S - "$repo" "$destination" "$runtime" "$nodebinary" <<'PY'
import hashlib, json, os, pathlib, re, shutil, stat, subprocess, sys, tempfile

repo, target, runtime, node = map(pathlib.Path, sys.argv[1:])
def protected(path):
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise RuntimeError('Protected real installation paths are required')
    for entry in (path, *path.parents):
        info = entry.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o7022:
            raise RuntimeError('Protected root-owned installation paths are required')
def source_file(path, root_owned=False):
    resolved = path.resolve(strict=True)
    info = resolved.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o7022 or info.st_nlink != 1 or (root_owned and info.st_uid != 0):
        raise RuntimeError('Untrusted runtime source')
    if 'security.capability' in os.listxattr(resolved):
        raise RuntimeError('Runtime file capabilities are not accepted')
    if root_owned:
        protected(resolved.parent)
    return resolved
if not target.is_absolute() or len(target.parts) < 3 or not re.fullmatch(r'groundwork-native-executor(?:-[A-Za-z0-9_.-]+)?', target.name):
    raise RuntimeError('Use a dedicated absolute groundwork-native-executor installation directory')
protected(target.parent)
if target.exists() or target.is_symlink():
    raise RuntimeError('Installation directory already exists; choose a new reviewed version directory')
protected(runtime)
node = source_file(node, True)
for filename in ('nativeAdapters.js', 'engineeringBasis.js'):
    if not (repo / 'server/dist' / filename).is_file():
        raise RuntimeError('Build the server before staging')
if not (repo / 'node_modules/zod').is_dir():
    raise RuntimeError('Install locked dependencies before staging')
hashes = {}
with open(source_file(runtime / 'binary-sha256.txt', True), encoding='ascii') as handle:
    for line in handle:
        digest, filename = line.strip().split(None, 1)
        source = pathlib.Path(filename)
        if not re.fullmatch(r'[a-f0-9]{64}', digest) or source not in {runtime / 'bin' / name for name in ('OpenSees','dwg2dxf','dxf2dwg')}:
            raise RuntimeError('Unexpected native binary manifest')
        with open(source_file(source, True), 'rb') as binary:
            if hashlib.file_digest(binary, 'sha256').hexdigest() != digest:
                raise RuntimeError('Native binary fingerprint changed')
        hashes[source.name] = digest
if set(hashes) != {'OpenSees','dwg2dxf','dxf2dwg'}:
    raise RuntimeError('Incomplete native binary manifest')
target.mkdir(mode=0o700)
staging = pathlib.Path(tempfile.mkdtemp(prefix='bundle-staging.', dir=target))
try:
    copied = set()
    def copy(source, relative, executable=False, root_owned=False):
        source = source_file(pathlib.Path(source), root_owned)
        relative = pathlib.PurePosixPath(relative)
        if relative.is_absolute() or any(part in ('.','..') for part in relative.parts):
            raise RuntimeError('Unexpected staged path')
        output = staging / str(relative)
        if output.exists():
            return
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        # Copy bytes and reviewed modes only; never propagate xattrs, ACLs,
        # hard links, capabilities, timestamps or setuid/setgid permissions.
        with open(source, 'rb') as source_handle, open(output, 'xb') as destination_handle:
            shutil.copyfileobj(source_handle, destination_handle, 1024 * 1024)
        os.chmod(output, 0o755 if executable else 0o644)
    queue = [(node, 'usr/bin/node'), (pathlib.Path('/usr/bin/prlimit'), 'usr/bin/prlimit'), (pathlib.Path('/usr/bin/setpriv'), 'usr/bin/setpriv')]
    queue += [(runtime / 'bin' / name, 'runtime/bin/' + name) for name in ('OpenSees','dwg2dxf','dxf2dwg')]
    while queue:
        source, relative = queue.pop()
        if relative in copied:
            continue
        copied.add(relative)
        source = source_file(source, True)
        copy(source, relative, True, True)
        response = subprocess.run(['/usr/bin/ldd', str(source)], capture_output=True, text=True, check=True, env={'PATH':'/usr/bin:/bin'})
        if 'not found' in response.stdout:
            raise RuntimeError('Required native library is missing')
        for filename in re.findall(r'(/[^\s()]+)', response.stdout):
            queue.append((pathlib.Path(filename), filename.lstrip('/')))
    for filename in ('nativeAdapters.js','engineeringBasis.js'):
        copy(repo / 'server/dist' / filename, 'app/' + filename)
    copy(repo / 'scripts/native-executor-job.mjs', 'app/native-executor-job.mjs')
    # Existing dependencies are trusted as locked build inputs, but link and
    # file-type anomalies in a package are rejected rather than followed.
    for package, prefix in ((repo / 'node_modules/zod','app/node_modules/zod'), (pathlib.Path('/usr/share/tcltk/tcl8.6'),'usr/share/tcltk/tcl8.6')):
        if not package.is_dir() or package.is_symlink():
            raise RuntimeError('Required runtime package is missing')
        for source in package.rglob('*'):
            info = source.lstat()
            if stat.S_ISDIR(info.st_mode):
                if source.is_symlink(): raise RuntimeError('Linked package directories are not accepted')
                continue
            if not stat.S_ISREG(info.st_mode) or source.is_symlink() or info.st_nlink != 1:
                raise RuntimeError('Linked or special package entries are not accepted')
            copy(source, prefix + '/' + str(source.relative_to(package)), False, package == pathlib.Path('/usr/share/tcltk/tcl8.6'))
    # Ubuntu may externalize these Node builtins; standalone Node embeds them.
    for filename in ('/usr/share/nodejs/acorn-walk/dist/walk.js','/usr/share/nodejs/acorn/dist/acorn.js','/usr/share/nodejs/cjs-module-lexer/dist/lexer.js','/usr/share/nodejs/cjs-module-lexer/lexer.js','/usr/share/nodejs/minimatch/dist/cjs/index.bundle.js','/usr/share/nodejs/undici/undici-fetch.js'):
        if pathlib.Path(filename).is_file(): copy(filename, filename.lstrip('/'), False, True)
    (staging / 'app/package.json').write_text('{"type":"module"}\n', encoding='utf8')
    (staging / 'etc').mkdir(mode=0o755, exist_ok=True)
    (staging / 'etc/passwd').write_text('root:x:0:0:root:/:/nonexistent\nnative:x:10001:10001:native:/jobs:/nonexistent\n', encoding='ascii')
    (staging / 'etc/group').write_text('root:x:0:\nnative:x:10001:\n', encoding='ascii')
    for name in ('jobs','proc','dev','tmp'):
        (staging / name).mkdir(mode=0o755, exist_ok=True)
    for entry in (staging, *staging.rglob('*')):
        info = entry.lstat()
        if info.st_uid != 0 or info.st_nlink < 1 or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or entry.is_symlink():
            raise RuntimeError('Unexpected staged filesystem entry')
        if stat.S_ISDIR(info.st_mode): os.chmod(entry,0o755)
        elif entry.relative_to(staging).as_posix() not in copied: os.chmod(entry,0o644)
    entries = []
    for entry in sorted(staging.rglob('*')):
        if entry.is_file():
            with open(entry,'rb') as handle: digest = hashlib.file_digest(handle,'sha256').hexdigest()
            info=entry.stat()
            entries.append({'path':entry.relative_to(staging).as_posix(),'size':info.st_size,'mode':stat.S_IMODE(info.st_mode),'sha256':digest})
    manifest = target / 'bundle-manifest.json'
    manifest.write_text(json.dumps({'version':1,'files':entries},separators=(',',':'))+'\n',encoding='ascii')
    os.chmod(manifest,0o600)
    # Broker source is installed beside, never inside, the child filesystem.
    source = source_file(repo / 'scripts/native-executor-broker.py')
    with open(source,'rb') as input_file, open(target / 'native-executor-broker.py','xb') as output_file:
        shutil.copyfileobj(input_file,output_file)
    os.chmod(target / 'native-executor-broker.py',0o700)
    (target / 'state').mkdir(mode=0o700)
    staging.rename(target / 'bundle')
    print('Sealed executor staged; no service or native queue was enabled.')
except BaseException:
    # Only this invocation's dedicated, verified staging directory is removed.
    if staging.exists() and staging.parent == target and staging.name.startswith('bundle-staging.') and staging.resolve() == staging:
        shutil.rmtree(staging)
    raise
PY
