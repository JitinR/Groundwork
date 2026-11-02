#!/usr/bin/env bash
# Build the two adapter-contract versions from official source archives.
# This does not start or enable the application worker.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(uname -s) = Linux && $(uname -m) = x86_64 && $(id -u) = 0 ]] || { echo 'Requires root on x86_64 Linux.' >&2; exit 1; }
root=/opt/groundwork-native-acceptance
mkdir -p "$root/downloads" "$root/sources" "$root/build" "$root/runtime/bin"
exec 9>"$root/build.lock"
flock -n 9 || { echo 'Another native acceptance build is running.' >&2; exit 1; }
cd "$root/downloads"
fetch() {
  local url=$1 filename=$2 digest=$3
  if [[ ! -f $filename ]]; then curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --max-time 300 "$url" -o "$filename"; fi
  printf '%s  %s\n' "$digest" "$filename" | sha256sum --check --strict
}
fetch https://ftp.gnu.org/gnu/libredwg/libredwg-0.13.4.tar.xz libredwg-0.13.4.tar.xz 7e153ea4dac4cbf3dc9c50b9ef7a5604e09cdd4c5520bcf8017877bbe1422cd5
fetch https://codeload.github.com/OpenSees/OpenSees/tar.gz/refs/tags/v3.8.0 OpenSees-v3.8.0.tar.gz 395d89f97ad0fe2a857e31b045c96badf23ad19ba8ce38f21c5a5d7891091810
[[ -d $root/sources/libredwg-0.13.4 ]] || tar -xf libredwg-0.13.4.tar.xz -C "$root/sources"
[[ -d $root/sources/OpenSees-3.8.0 ]] || tar -xf OpenSees-v3.8.0.tar.gz -C "$root/sources"
jobs=${GROUNDWORK_NATIVE_BUILD_JOBS:-2}
[[ $jobs =~ ^[1-4]$ ]] || { echo 'Build concurrency must be 1 through 4.' >&2; exit 1; }
mkdir -p "$root/build/libredwg"
cd "$root/build/libredwg"
# Keep C11 semantics on newer distribution compilers (GCC 15 defaults to C23).
CFLAGS='-O1 -std=gnu11' "$root/sources/libredwg-0.13.4/configure" --prefix="$root/runtime" --disable-shared --disable-bindings --disable-docs --disable-Werror --disable-werror
make -j"$jobs"
make install
# CMake 4 requires the compatibility floor for bundled legacy numerical libs.
cmake -S "$root/sources/OpenSees-3.8.0" -B "$root/build/opensees" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DOPS_FINAL_TARGET=OpenSees -DTCL_INCLUDE_PATH=/usr/include/tcl8.6
cmake --build "$root/build/opensees" --target OpenSees --parallel "$jobs"
install -m 0755 "$root/build/opensees/OpenSees" "$root/runtime/bin/OpenSees"
"$root/runtime/bin/dwg2dxf" --version
"$root/runtime/bin/dxf2dwg" --version
printf 'puts [version]\nexit 0\n' > "$root/build/version.tcl"
"$root/runtime/bin/OpenSees" "$root/build/version.tcl"
sha256sum "$root/runtime/bin/dwg2dxf" "$root/runtime/bin/dxf2dwg" "$root/runtime/bin/OpenSees" > "$root/runtime/binary-sha256.txt"
echo "Built native acceptance runtimes under $root/runtime; application worker remains disabled."
