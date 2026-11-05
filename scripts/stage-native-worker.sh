#!/usr/bin/env bash
# Build a private, allowlisted network-worker filesystem. No service is started.
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(uname -s) = Linux && $(uname -m) = x86_64 && $(id -u) = 0 && $# -le 1 ]] || { echo 'Requires root on x86_64 Linux and at most one installation path.' >&2; exit 78; }
repo=$(cd "$(dirname "$0")/.." && pwd -P)
python3 -I -S - "$repo" "${1:-/opt/groundwork-native-worker}" "${GROUNDWORK_NATIVE_NODE_PATH:-/usr/bin/node}" "${GROUNDWORK_NATIVE_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}" "${GROUNDWORK_NATIVE_RESOLVER_FILE:-/etc/resolv.conf}" <<'PY'
import hashlib,json,os,pathlib,re,shutil,stat,subprocess,sys
repo,target,node,ca,resolver=map(pathlib.Path,sys.argv[1:])
def protected(path):
    if not path.is_absolute() or path.resolve(strict=True)!=path: raise RuntimeError('Protected real paths required')
    for entry in (path,*path.parents):
        info=entry.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o7022: raise RuntimeError('Protected root-owned paths required')
def source(path,system=False):
    resolved=path.resolve(strict=True); info=resolved.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_mode&0o7022 or 'security.capability' in os.listxattr(resolved): raise RuntimeError('Untrusted source file')
    if system:
        if info.st_uid!=0: raise RuntimeError('Root-owned runtime required')
        protected(resolved.parent)
    return resolved
if not target.is_absolute() or len(target.parts)<3 or not re.fullmatch(r'groundwork-native-worker(?:-[A-Za-z0-9_.-]+)?',target.name): raise RuntimeError('Dedicated installation directory required')
protected(target.parent)
if target.exists() or target.is_symlink(): raise RuntimeError('Choose a new reviewed installation directory')
modules=('nativeWorkerClient.js','nativeWorkerClientConfig.js','nativeWorkerEntry.js','nativeWorkerExecutorClient.js','nativeWorkerLoop.js')
for name in modules: source(repo/'server/dist'/name)
node=source(node,True); ca=source(ca,True); resolver=source(resolver,True)
if not 0<ca.stat().st_size<=4*1024*1024: raise RuntimeError('Bounded CA bundle required')
if not 0<resolver.stat().st_size<=4096: raise RuntimeError('Bounded resolver configuration required')
target.mkdir(mode=0o700); bundle=target/'bundle'; bundle.mkdir(mode=0o755)
copied=set()
def copy(item,relative,executable=False,system=False):
    relative=pathlib.PurePosixPath(relative)
    if relative.is_absolute() or any(part in ('.','..') for part in relative.parts): raise RuntimeError('Unexpected destination')
    output=bundle/str(relative)
    if output.exists(): return
    item=source(pathlib.Path(item),system); output.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
    with open(item,'rb') as incoming,open(output,'xb') as outgoing: shutil.copyfileobj(incoming,outgoing,1024*1024)
    os.chmod(output,0o755 if executable else 0o644)
queue=[(node,'usr/bin/node'),(pathlib.Path('/usr/bin/setpriv'),'usr/bin/setpriv')]
while queue:
    item,relative=queue.pop()
    if relative in copied: continue
    copied.add(relative); item=source(item,True); copy(item,relative,True,True)
    result=subprocess.run(['/usr/bin/ldd',str(item)],capture_output=True,text=True,check=True,env={'PATH':'/usr/bin:/bin'})
    if 'not found' in result.stdout: raise RuntimeError('Missing runtime library')
    for filename in re.findall(r'(/[^\s()]+)',result.stdout): queue.append((pathlib.Path(filename),filename.lstrip('/')))
for name in modules: copy(repo/'server/dist'/name,'app/'+name)
for filename in ('/usr/share/nodejs/acorn-walk/dist/walk.js','/usr/share/nodejs/acorn/dist/acorn.js','/usr/share/nodejs/cjs-module-lexer/dist/lexer.js','/usr/share/nodejs/cjs-module-lexer/lexer.js','/usr/share/nodejs/minimatch/dist/cjs/index.bundle.js','/usr/share/nodejs/undici/undici-fetch.js'):
    if pathlib.Path(filename).is_file(): copy(filename,filename.lstrip('/'),system=True)
# OpenSSL distributions use different default certificate paths; all contain
# exactly the same reviewed CA bytes. No worker environment can override TLS.
for filename in ('etc/ssl/cert.pem','usr/lib/ssl/cert.pem','etc/ssl/certs/ca-certificates.crt'): copy(ca,filename,system=True)
copy(resolver,'etc/resolv.conf',system=True)
for name in ('proc','dev','run','credentials'): (bundle/name).mkdir(mode=0o755,exist_ok=True)
(bundle/'run/executor').mkdir(mode=0o750); os.chown(bundle/'run/executor',0,10002)
(bundle/'credentials/token').touch(mode=0o400)
(bundle/'app/package.json').write_text('{"type":"module"}\n')
(bundle/'etc/nsswitch.conf').write_text('hosts: files dns\n')
(bundle/'etc/hosts').write_text('127.0.0.1 localhost\n::1 localhost\n')
(bundle/'etc/passwd').write_text('root:x:0:0:root:/:/nonexistent\nworker:x:10002:10002:worker:/:/nonexistent\n')
(bundle/'etc/group').write_text('root:x:0:\nworker:x:10002:\n')
for path in (bundle,*bundle.rglob('*')):
    info=path.lstat()
    if info.st_uid!=0 or path.is_symlink() or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)): raise RuntimeError('Unexpected staged entry')
    if path==bundle/'run/executor': os.chmod(path,0o750)
    elif stat.S_ISDIR(info.st_mode): os.chmod(path,0o755)
    elif path==bundle/'credentials/token': os.chmod(path,0o400)
    elif path.relative_to(bundle).as_posix() not in copied: os.chmod(path,0o644)
entries=[]
for path in sorted(bundle.rglob('*')):
    if path.is_file():
        with open(path,'rb') as handle: digest=hashlib.file_digest(handle,'sha256').hexdigest()
        info=path.stat(); entries.append({'path':path.relative_to(bundle).as_posix(),'size':info.st_size,'mode':stat.S_IMODE(info.st_mode),'sha256':digest})
(target/'bundle-manifest.json').write_text(json.dumps({'version':1,'files':entries},separators=(',',':'))+'\n'); os.chmod(target/'bundle-manifest.json',0o600)
with open(source(repo/'scripts/native-worker-launcher.py'),'rb') as incoming,open(target/'native-worker-launcher.py','xb') as outgoing: shutil.copyfileobj(incoming,outgoing)
os.chmod(target/'native-worker-launcher.py',0o700)
(target/'state').mkdir(mode=0o700)
print('Sealed network worker staged; no service or queue was enabled.')
PY
