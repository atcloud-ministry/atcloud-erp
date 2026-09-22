#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly COMPOSE_FILE="${REPOSITORY_ROOT}/docker-compose.test.yml"
readonly MONGO_CONTAINER="atcloud-mongodb-test-rs"
readonly LOCK_DIRECTORY="/tmp/atcloud-g1-release-capacity.lock"
readonly STATUS_FILE="${TMPDIR:-/tmp}/atcloud-g1-release-capacity.last-status"

lock_acquired=0
mongo_started_by_script=0
mongo_existed_before=0
database_name=""

cleanup() {
  local exit_code="$?"
  local cleanup_failed=0
  trap - EXIT
  set +e

  if [[ -n "${database_name}" ]] && [[ "${database_name}" =~ ^atcloud_g1_capacity_test_[A-Za-z0-9_]+$ ]]; then
    if ! docker exec "${MONGO_CONTAINER}" mongosh --quiet \
      --host 127.0.0.1 --port 27018 \
      --eval "db.getSiblingDB('${database_name}').dropDatabase()" \
      >/dev/null; then
      echo "Failed to drop guarded G1 capacity database ${database_name}." >&2
      cleanup_failed=1
    fi
  elif [[ -n "${database_name}" ]]; then
    echo "Refusing to drop an unexpected G1 capacity database target." >&2
    cleanup_failed=1
  fi

  if [[ "${mongo_started_by_script}" -eq 1 ]]; then
    if [[ "${mongo_existed_before}" -eq 1 ]]; then
      if ! docker compose -f "${COMPOSE_FILE}" stop mongodb-replica >/dev/null; then
        echo "Failed to restore the local rs0 container to stopped state." >&2
        cleanup_failed=1
      fi
    elif ! docker compose -f "${COMPOSE_FILE}" down >/dev/null; then
      echo "Failed to remove the local rs0 container created for G1 capacity." >&2
      cleanup_failed=1
    fi
  fi

  if [[ "${lock_acquired}" -eq 1 ]]; then
    rm -f -- "${LOCK_DIRECTORY}/owner.pid" || cleanup_failed=1
    rmdir "${LOCK_DIRECTORY}" 2>/dev/null || cleanup_failed=1
  fi
  if [[ "${exit_code}" -eq 0 && "${cleanup_failed}" -ne 0 ]]; then
    exit_code=1
  fi
  printf 'exit_code=%s\ncompleted_at=%s\ndatabase=%s\n' \
    "${exit_code}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${database_name}" \
    >"${STATUS_FILE}"
  exit "${exit_code}"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -n "${MONGODB_URI:-}" || -n "${MONGODB_TEST_URI:-}" ]]; then
  echo "G1 capacity refuses inherited MongoDB configuration; it only uses its guarded loopback rs0 database." >&2
  exit 2
fi

for command in docker npm node; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "${command} is required for G1 release-capacity qualification." >&2
    exit 2
  fi
done

cd "${REPOSITORY_ROOT}"
printf 'exit_code=running\nstarted_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${STATUS_FILE}"
if ! mkdir "${LOCK_DIRECTORY}" 2>/dev/null; then
  lock_owner="unknown"
  if [[ -r "${LOCK_DIRECTORY}/owner.pid" ]]; then
    IFS= read -r lock_owner <"${LOCK_DIRECTORY}/owner.pid" || lock_owner="unknown"
  fi
  echo "Another G1 release-capacity run owns ${LOCK_DIRECTORY} (PID: ${lock_owner})." >&2
  exit 2
fi
lock_acquired=1
printf '%s\n' "$$" >"${LOCK_DIRECTORY}/owner.pid"

run_token="${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-1}_$$_$(date +%s)"
run_token="${run_token//[^a-zA-Z0-9_]/_}"
database_name="atcloud_g1_capacity_test_${run_token}"
database_name="${database_name:0:63}"

if docker inspect "${MONGO_CONTAINER}" >/dev/null 2>&1; then
  mongo_existed_before=1
fi
if [[ "$(docker inspect --format '{{.State.Running}}' "${MONGO_CONTAINER}" 2>/dev/null || true)" != "true" ]]; then
  mongo_started_by_script=1
  docker compose -f "${COMPOSE_FILE}" up -d mongodb-replica
fi

bash "${REPOSITORY_ROOT}/scripts/init-test-replica-set.sh"

export NODE_ENV="test"
export ALUMNI_NETWORK_RELEASE_AVAILABLE="true"
export VITEST_DB_ISOLATION="false"
export MONGODB_TEST_URI="mongodb://127.0.0.1:27018/${database_name}?replicaSet=rs0"

echo "Running guarded G1 capacity qualification against ${MONGODB_TEST_URI}."
npm run -s test:backend:perf:g1-release
