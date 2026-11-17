#!/usr/bin/env bash
set -euo pipefail

# Ubuntu 24.04's default PostgreSQL major differs from the hosted database.
# Use the PostgreSQL project's signed Apt repository for matching PG17 clients.
source /etc/os-release
if [[ "${ID}" != "ubuntu" || "${VERSION_CODENAME}" != "noble" ]]; then
  echo 'PostgreSQL client setup requires the pinned Ubuntu 24.04 runner.' >&2
  exit 1
fi
sudo install -d /usr/share/postgresql-common/pgdg
curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  --connect-timeout 10 --max-time 20 --retry 3 --retry-all-errors --retry-max-time 75 \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  --output "${RUNNER_TEMP}/postgresql-repository.asc"
sudo install -m 0644 "${RUNNER_TEMP}/postgresql-repository.asc" /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
printf '%s\n' 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main' \
  | sudo tee /etc/apt/sources.list.d/groundwork-pgdg.list >/dev/null
sudo apt-get update
sudo apt-get install --yes postgresql-client-17
"/usr/lib/postgresql/17/bin/pg_dump" --version
echo '/usr/lib/postgresql/17/bin' >> "${GITHUB_PATH}"
