#!/usr/bin/env bash

set -euo pipefail

readonly CONTAINER_NAME="atcloud-mongodb-test-rs"
readonly MONGO_HOST="127.0.0.1"
readonly MONGO_PORT="27018"
readonly REPLICA_SET_NAME="rs0"
readonly MEMBER_ADDRESS="${MONGO_HOST}:${MONGO_PORT}"
readonly DEFAULT_TIMEOUT_SECONDS="60"

timeout_seconds="${MONGO_RS_INIT_TIMEOUT_SECONDS:-${DEFAULT_TIMEOUT_SECONDS}}"

if ! [[ "${timeout_seconds}" =~ ^[0-9]+$ ]] ||
  ((timeout_seconds < 1 || timeout_seconds > 300)); then
  echo "MONGO_RS_INIT_TIMEOUT_SECONDS must be an integer from 1 through 300." >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to initialize the test replica set." >&2
  exit 3
fi

container_id="$(
  docker ps \
    --filter "name=^/${CONTAINER_NAME}$" \
    --filter "status=running" \
    --format '{{.ID}}'
)"

if [[ -z "${container_id}" ]] || [[ "${container_id}" == *$'\n'* ]]; then
  echo "Expected exactly one running ${CONTAINER_NAME} container." >&2
  exit 4
fi

published_port="$(docker port "${CONTAINER_NAME}" "${MONGO_PORT}/tcp")"
if [[ "${published_port}" != "${MEMBER_ADDRESS}" ]]; then
  echo "${CONTAINER_NAME} must publish only ${MEMBER_ADDRESS}; found: ${published_port}" >&2
  exit 5
fi

container_command="$(docker inspect --format '{{json .Config.Cmd}}' "${CONTAINER_NAME}")"
if [[ "${container_command}" != *'"--replSet","rs0"'* ]] ||
  [[ "${container_command}" != *'"--port","27018"'* ]]; then
  echo "${CONTAINER_NAME} is not configured for replica set rs0 on port 27018." >&2
  exit 6
fi

deadline=$((SECONDS + timeout_seconds))
until docker exec "${CONTAINER_NAME}" mongosh --quiet \
  --host "${MONGO_HOST}" \
  --port "${MONGO_PORT}" \
  --eval 'quit(db.adminCommand({ ping: 1 }).ok === 1 ? 0 : 1)' \
  >/dev/null 2>&1; do
  if ((SECONDS >= deadline)); then
    echo "MongoDB did not become reachable within ${timeout_seconds} seconds." >&2
    exit 7
  fi
  sleep 1
done

docker exec "${CONTAINER_NAME}" mongosh --quiet \
  --host "${MONGO_HOST}" \
  --port "${MONGO_PORT}" \
  --eval '
    const replicaSetName = "rs0";
    const memberAddress = "127.0.0.1:27018";

    try {
      const config = rs.conf();
      const configuredMembers = config.members.map((member) => member.host);
      if (
        config._id !== replicaSetName ||
        configuredMembers.length !== 1 ||
        configuredMembers[0] !== memberAddress
      ) {
        print("Existing replica-set configuration does not match the test contract.");
        printjson(config);
        quit(21);
      }
    } catch (error) {
      const notInitialized =
        error.code === 94 ||
        error.codeName === "NotYetInitialized" ||
        /no replset config has been received/i.test(String(error.message));

      if (!notInitialized) {
        printjson(error);
        quit(22);
      }

      const result = rs.initiate({
        _id: replicaSetName,
        members: [{ _id: 0, host: memberAddress }],
      });
      if (result.ok !== 1) {
        printjson(result);
        quit(23);
      }
    }
  '

until docker exec "${CONTAINER_NAME}" mongosh --quiet \
  --host "${MONGO_HOST}" \
  --port "${MONGO_PORT}" \
  --eval '
    const hello = db.adminCommand({ hello: 1 });
    quit(
      hello.ok === 1 && hello.setName === "rs0" && hello.isWritablePrimary === true
        ? 0
        : 1
    );
  ' \
  >/dev/null 2>&1; do
  if ((SECONDS >= deadline)); then
    echo "Replica set ${REPLICA_SET_NAME} did not elect a writable primary within ${timeout_seconds} seconds." >&2
    exit 8
  fi
  sleep 1
done

echo "Replica set ${REPLICA_SET_NAME} is writable at mongodb://${MEMBER_ADDRESS}/?replicaSet=${REPLICA_SET_NAME}."
