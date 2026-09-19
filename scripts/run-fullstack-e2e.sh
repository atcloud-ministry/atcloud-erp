#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly COMPOSE_FILE="${REPOSITORY_ROOT}/docker-compose.test.yml"
readonly MONGO_CONTAINER="atcloud-mongodb-test-rs"
readonly BACKEND_PORT="5011"
readonly FRONTEND_PORT="4174"
readonly LOCK_DIRECTORY="/tmp/atcloud-fullstack-e2e.lock"

mongo_started_by_script=0
mongo_existed_before=0
lock_acquired=0
backend_pid=""
frontend_pid=""
fixture_cleanup_required=0
runtime_dir=""

stop_process() {
  local pid="$1"
  if [[ -z "${pid}" ]] || ! kill -0 "${pid}" 2>/dev/null; then
    return
  fi

  kill "${pid}" 2>/dev/null || true
  for _ in {1..50}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || true
      return
    fi
    sleep 0.2
  done

  kill -9 "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
}

remove_runtime_dir() {
  if [[ -z "${runtime_dir}" || ! -d "${runtime_dir}" ]]; then
    return 0
  fi

  case "$(basename "${runtime_dir}")" in
    atcloud-fullstack-e2e.*) rm -rf -- "${runtime_dir}" ;;
    *)
      echo "Refusing to remove unexpected runtime directory." >&2
      return 1
      ;;
  esac
}

cleanup() {
  local exit_code="$?"
  local cleanup_failed=0
  trap - EXIT
  set +e

  stop_process "${frontend_pid}"
  stop_process "${backend_pid}"

  if [[ "${fixture_cleanup_required}" -eq 1 ]]; then
    if ! npm run -s e2e:fixture --workspace=atcloud-signup-system-backend -- cleanup; then
      echo "Failed to drop the guarded full-stack E2E database." >&2
      cleanup_failed=1
    fi
  fi

  if [[ "${mongo_started_by_script}" -eq 1 ]]; then
    if [[ "${mongo_existed_before}" -eq 1 ]]; then
      if ! docker compose -f "${COMPOSE_FILE}" stop mongodb-replica >/dev/null; then
        echo "Failed to restore the existing MongoDB container to stopped state." >&2
        cleanup_failed=1
      fi
    elif ! docker compose -f "${COMPOSE_FILE}" down >/dev/null; then
      echo "Failed to remove the MongoDB container created by this script." >&2
      cleanup_failed=1
    fi
  fi

  if [[ "${exit_code}" -ne 0 && -n "${runtime_dir}" ]]; then
    echo "Backend log:" >&2
    tail -n 120 "${runtime_dir}/backend.log" 2>/dev/null >&2 || true
    echo "Frontend log:" >&2
    tail -n 120 "${runtime_dir}/frontend.log" 2>/dev/null >&2 || true
  fi

  if ! remove_runtime_dir; then
    echo "Failed to remove the full-stack E2E runtime directory." >&2
    cleanup_failed=1
  fi
  if [[ "${lock_acquired}" -eq 1 ]]; then
    if ! rm -f -- "${LOCK_DIRECTORY}/owner.pid"; then
      echo "Failed to remove the full-stack E2E lock owner metadata." >&2
      cleanup_failed=1
    fi
    rmdir "${LOCK_DIRECTORY}" 2>/dev/null || {
      echo "Failed to release the full-stack E2E lock." >&2
      cleanup_failed=1
    }
  fi
  if [[ "${exit_code}" -eq 0 && "${cleanup_failed}" -ne 0 ]]; then
    exit_code=1
  fi
  exit "${exit_code}"
}

wait_for_http() {
  local label="$1"
  local url="$2"
  local pid="$3"

  for _ in {1..120}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      echo "${label} exited before becoming ready." >&2
      return 1
    fi
    if curl --fail --silent --max-time 2 "${url}" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  echo "${label} did not become ready at ${url}." >&2
  return 1
}

assert_loopback_port_available() {
  local port="$1"
  node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => process.exit(error ? 1 : 0));
    });
  ' "${port}" || {
    echo "Loopback port ${port} is already in use." >&2
    return 1
  }
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command in docker npm node curl grep; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "${command} is required for full-stack E2E." >&2
    exit 2
  fi
done

cd "${REPOSITORY_ROOT}"
if ! mkdir "${LOCK_DIRECTORY}" 2>/dev/null; then
  lock_owner="unknown"
  if [[ -r "${LOCK_DIRECTORY}/owner.pid" ]]; then
    IFS= read -r lock_owner <"${LOCK_DIRECTORY}/owner.pid" || lock_owner="unknown"
  fi
  echo "Another full-stack E2E run owns ${LOCK_DIRECTORY} (PID: ${lock_owner})." >&2
  echo "If that process no longer exists, remove this exact lock directory before retrying." >&2
  exit 2
fi
lock_acquired=1
if ! printf '%s\n' "$$" >"${LOCK_DIRECTORY}/owner.pid"; then
  echo "Failed to write full-stack E2E lock owner metadata." >&2
  exit 2
fi
runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/atcloud-fullstack-e2e.XXXXXX")"
assert_loopback_port_available "${BACKEND_PORT}"
assert_loopback_port_available "${FRONTEND_PORT}"

run_token="${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-1}_$$_$(date +%s)"
run_token="${run_token//[^a-zA-Z0-9_]/_}"
database_name="atcloud_fullstack_e2e_${run_token}"
database_name="${database_name:0:62}"

export NODE_ENV="fullstack-e2e"
export FULLSTACK_E2E_MONGODB_URI="mongodb://127.0.0.1:27018/${database_name}?replicaSet=rs0"
export FULLSTACK_E2E_BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
export FULLSTACK_E2E_FRONTEND_URL="http://127.0.0.1:${FRONTEND_PORT}"
export FULLSTACK_E2E_USERNAME="e2e_super_admin"
export FULLSTACK_E2E_EMAIL="fullstack.e2e@example.com"
export FULLSTACK_E2E_PASSWORD="FullstackE2E9!"

export MONGODB_URI="${FULLSTACK_E2E_MONGODB_URI}"
export PORT="${BACKEND_PORT}"
export HTTP_BIND_HOST="127.0.0.1"
export FRONTEND_URL="${FULLSTACK_E2E_FRONTEND_URL}"
export VITE_API_URL="${FULLSTACK_E2E_BACKEND_URL}/api"
export VITE_SOCKET_URL="${FULLSTACK_E2E_BACKEND_URL}"
export UPLOAD_DESTINATION="${runtime_dir}/uploads"
export JWT_ACCESS_SECRET="fullstack-e2e-access-secret-never-use-outside-tests"
export JWT_REFRESH_SECRET="fullstack-e2e-refresh-secret-never-use-outside-tests"
export STRIPE_SECRET_KEY="sk_test_fullstack_e2e_placeholder"
export SCHEDULER_ENABLED="false"
export NOTIFICATION_OUTBOX_ENABLED="true"
export MONGO_TRANSACTIONS_REQUIRED="true"
export SINGLE_INSTANCE_ENFORCE="true"
export WEB_CONCURRENCY="1"
export ALUMNI_NETWORK_RELEASE_AVAILABLE="true"
export ALUMNI_CONTACT_LOOKUP_KEY_V1="ERERERERERERERERERERERERERERERERERERERERERE"
export ALUMNI_INVITATION_TOKEN_KEY_V1="IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI"

if docker inspect "${MONGO_CONTAINER}" >/dev/null 2>&1; then
  mongo_existed_before=1
fi

if [[ "$(docker inspect --format '{{.State.Running}}' "${MONGO_CONTAINER}" 2>/dev/null || true)" != "true" ]]; then
  mongo_started_by_script=1
  docker compose -f "${COMPOSE_FILE}" up -d mongodb-replica
fi

bash "${REPOSITORY_ROOT}/scripts/init-test-replica-set.sh"
fixture_cleanup_required=1
npm run -s build --workspace=@atcloud/shared-time
npm run -s build --workspace=atcloud-signup-system-backend
NODE_ENV=production npm run -s build --workspace=frontend
if grep -R -F -- "jsxDEV" "${REPOSITORY_ROOT}/frontend/dist/assets" >/dev/null; then
  echo "Frontend E2E build contains the React development runtime." >&2
  exit 1
fi
if grep -R -F -- "${REPOSITORY_ROOT}" "${REPOSITORY_ROOT}/frontend/dist/assets" >/dev/null; then
  echo "Frontend E2E build contains an absolute build-machine source path." >&2
  exit 1
fi
npm run -s e2e:fixture --workspace=atcloud-signup-system-backend -- seed
npm run -s migration --workspace=atcloud-signup-system-backend -- \
  apply \
  --execute \
  --yes \
  --confirm-db "${database_name}" \
  --operator fullstack-e2e \
  --json

(
  cd "${REPOSITORY_ROOT}/backend"
  exec node dist/index.js
) >"${runtime_dir}/backend.log" 2>&1 &
backend_pid="$!"

(
  cd "${REPOSITORY_ROOT}/frontend"
  exec "${REPOSITORY_ROOT}/frontend/node_modules/.bin/vite" preview \
    --host 127.0.0.1 \
    --port "${FRONTEND_PORT}" \
    --strictPort
) >"${runtime_dir}/frontend.log" 2>&1 &
frontend_pid="$!"

wait_for_http "Backend" "${FULLSTACK_E2E_BACKEND_URL}/api/readiness" "${backend_pid}"
wait_for_http "Frontend" "${FULLSTACK_E2E_FRONTEND_URL}/" "${frontend_pid}"

npm run -s test:e2e:fullstack:playwright --workspace=frontend
