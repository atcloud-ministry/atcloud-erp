#!/usr/bin/env bash

set -euo pipefail

if (($# == 0)); then
  echo "Usage: with-test-mongo.sh <test command> [args...]" >&2
  exit 2
fi

# CI supplies its own isolated MongoDB test URI. Locally, use the same
# loopback-only replica set instead of silently falling back to port 27017.
if [[ -z "${MONGODB_TEST_URI:-}" ]]; then
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

  if ! command -v docker >/dev/null 2>&1; then
    echo "Integration tests need Docker or an explicit MONGODB_TEST_URI." >&2
    exit 3
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "Start Docker Desktop before running integration tests, or set MONGODB_TEST_URI to a test replica set." >&2
    exit 4
  fi

  docker compose -f "${script_dir}/../docker-compose.test.yml" up -d mongodb-replica
  bash "${script_dir}/init-test-replica-set.sh"
  export MONGODB_TEST_URI="mongodb://127.0.0.1:27018/atcloud-signup-test?replicaSet=rs0"
fi

database_path="${MONGODB_TEST_URI%%\?*}"
database_name="${database_path##*/}"
if [[ "${database_name}" != *test* ]]; then
  echo "MONGODB_TEST_URI must name a database containing 'test'." >&2
  exit 5
fi

exec "$@"
