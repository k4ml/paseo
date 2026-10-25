#!/usr/bin/env bash
# Start the Paseo dev stack with one command: daemon (+ web UI) and Expo/Metro.
#
#   ./scripts/dev-stack.sh
#   PASEO_LISTEN=100.105.136.81:6767 EXPO_PORT=8082 ./scripts/dev-stack.sh
#
# The root npm scripts hardcode PASEO_LISTEN=127.0.0.1:6768 and EXPO_PORT=8081,
# which overrides any values exported in the shell. This wrapper calls the
# underlying scripts directly so the environment wins, and it starts the daemon
# (dev:app alone never starts one).
#
# Environment:
#   PASEO_LISTEN     Daemon bind address            (default: 127.0.0.1:6767)
#   EXPO_PORT        Metro port                     (default: 8082; advances if busy)
#   PASEO_WEB_UI     "0" disables the bundled web UI (default: enabled)
#   PASEO_PASSWORD   Optional daemon password
#   PASEO_DAEMON=0   Skip the daemon and only run Expo
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

export PATH="$ROOT_DIR/node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"

export PASEO_LISTEN="${PASEO_LISTEN:-127.0.0.1:6767}"
export EXPO_PORT="${EXPO_PORT:-8082}"
WEB_UI_ENABLED="${PASEO_WEB_UI:-1}"
RUN_DAEMON="${PASEO_DAEMON:-1}"

configure_dev_paseo_home

DAEMON_ENDPOINT="$(resolve_dev_daemon_endpoint)"

port_open() {
  local host="${1%:*}" port="${1##*:}"
  timeout 1 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null
}

pick_free_port() {
  local port="$1"
  local limit=$((port + 20))
  while [ "$port" -le "$limit" ]; do
    if ! port_open "127.0.0.1:${port}"; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
  done
  return 1
}

wait_for_daemon() {
  local deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS -m 2 "http://${DAEMON_ENDPOINT}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

STARTED_DAEMON=0
cleanup() {
  if [ "$STARTED_DAEMON" = "1" ]; then
    echo
    echo "Stopping daemon..."
    PASEO_LISTEN="$PASEO_LISTEN" npm run cli -- daemon stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [ "$RUN_DAEMON" != "0" ]; then
  if port_open "$DAEMON_ENDPOINT"; then
    echo "Daemon already running at ${DAEMON_ENDPOINT}; reusing it."
  else
    daemon_args=()
    if [ "$WEB_UI_ENABLED" != "0" ]; then
      daemon_args+=(--web-ui)
      if [ ! -d "$ROOT_DIR/packages/server/dist/server/web-ui" ]; then
        echo "warning: web UI bundle missing; run: npm run build:daemon-web-ui" >&2
      fi
    fi
    PASEO_LISTEN="$PASEO_LISTEN" npm run cli -- daemon start "${daemon_args[@]}"
    STARTED_DAEMON=1
    if ! wait_for_daemon; then
      echo "error: daemon did not become healthy at ${DAEMON_ENDPOINT}" >&2
      exit 1
    fi
  fi
fi

if port_open "127.0.0.1:${EXPO_PORT}"; then
  REQUESTED_PORT="$EXPO_PORT"
  EXPO_PORT="$(pick_free_port "$EXPO_PORT")" || {
    echo "error: no free Metro port near ${REQUESTED_PORT}" >&2
    exit 1
  }
  echo "Port ${REQUESTED_PORT} is busy; using ${EXPO_PORT} for Metro."
  export EXPO_PORT
fi

echo "══════════════════════════════════════════════════════"
echo "  Paseo Dev Stack"
echo "══════════════════════════════════════════════════════"
echo "  Daemon:  http://${DAEMON_ENDPOINT}"
echo "  Web UI:  http://${DAEMON_ENDPOINT}/"
echo "  Metro:   http://localhost:${EXPO_PORT}"
echo "  Home:    ${PASEO_HOME}"
echo "══════════════════════════════════════════════════════"

PASEO_LISTEN="$PASEO_LISTEN" EXPO_PORT="$EXPO_PORT" "$SCRIPT_DIR/dev-app.sh"
