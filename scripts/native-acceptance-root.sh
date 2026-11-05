#!/usr/bin/env bash
# Shared protected location for the pinned runtime build and adapter check.
native_acceptance_root() {
  local candidate=${GROUNDWORK_NATIVE_ACCEPTANCE_ROOT:-/opt/groundwork-native-acceptance}
  local entry owner mode
  if [[ $candidate != /* ||
        ! ${candidate##*/} =~ ^groundwork-native-acceptance(-[A-Za-z0-9_.-]+)?$ ||
        $(realpath -m -- "$candidate") != "$candidate" ]]; then
    echo 'Use a canonical dedicated groundwork-native-acceptance directory.' >&2
    return 78
  fi
  entry=$candidate
  if [[ ! -e $entry ]]; then entry=$(dirname -- "$entry"); fi
  while :; do
    if [[ ! -d $entry || -L $entry ]]; then
      printf 'Native acceptance directory unavailable: %s\n' "$entry" >&2
      return 78
    fi
    read -r owner mode < <(stat -c '%u %a' -- "$entry")
    if [[ $owner != 0 ]] || (( (8#$mode & 07022) != 0 )); then
      printf 'Native acceptance directory is not protected: %s\n' "$entry" >&2
      return 78
    fi
    [[ $entry != / ]] || break
    entry=$(dirname -- "$entry")
  done
  printf '%s\n' "$candidate"
}
