#!/usr/bin/env bash
set -euo pipefail

# The bundled listener is private and optional. Other configured origins are external proxies.
if [[ "${JIAN_CAVEMAN_ENABLED:-false}" != 'true' ||
      ( "${JIAN_CAVEMAN_PROXY_URL:-http://127.0.0.1:8788}" != 'http://127.0.0.1:8788' &&
        "${JIAN_CAVEMAN_PROXY_URL:-http://127.0.0.1:8788}" != 'http://127.0.0.1:8788/' ) ]]; then
  exec node dist/main.js
fi

CAVEMAN_MODE=record CAVEMAN_LISTEN=127.0.0.1:8788 CAVEMAN_PROXY_OWNER=start caveman-proxy &
proxy_pid=$!
gateway_pid=''

cleanup() {
  trap - TERM INT
  if [[ -n "$gateway_pid" ]]; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  kill "$proxy_pid" 2>/dev/null || true
  wait "$proxy_pid" 2>/dev/null || true
}
trap cleanup TERM INT

# Refuse to start the gateway if the proxy is unavailable. A later exit stops both processes.
ready=false
for _ in {1..50}; do
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    echo 'Caveman proxy exited before becoming ready' >&2
    wait "$proxy_pid"
    exit 1
  fi
  if nc -z 127.0.0.1 8788 2>/dev/null; then
    ready=true
    break
  fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  echo 'Caveman proxy did not become ready' >&2
  kill "$proxy_pid" 2>/dev/null || true
  wait "$proxy_pid" 2>/dev/null || true
  exit 1
fi

node dist/main.js &
gateway_pid=$!
set +e
wait -n -p ended_pid "$gateway_pid" "$proxy_pid"
status=$?
if [[ "${ended_pid:-}" == "$proxy_pid" ]]; then
  echo 'Caveman proxy stopped; stopping Jian' >&2
  status=1
fi
cleanup
exit "$status"
