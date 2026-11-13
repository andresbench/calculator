#!/usr/bin/env bash
# The Endfield calculator locally: the Vite dev server in the background + a browser.
#
#   launch.sh open      — start the server (unless running) and open it in a browser
#   launch.sh start     — start the server
#   launch.sh stop      — stop it
#   launch.sh restart   — restart it
#   launch.sh status    — status
#   launch.sh log       — server log
#
# The dev server rather than a static build: the Enka showcase import lives
# in it (app/enka.ts) and rewrites public/data/bundle.json, which the dev
# server serves without a rebuild. A transient systemd user unit owns the
# process — logs go to the journal, and nothing is left after stop.
set -uo pipefail

APP="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
UNIT="endfield-calc"
PORT=5173
URL="http://localhost:$PORT"
NODE_BIN="${NODE_BIN:-$HOME/.local/opt/node/bin}"
[ -d "$NODE_BIN" ] || NODE_BIN="$(dirname "$(command -v node)")"

sc() { systemctl --user "$@"; }
up() { curl -sf -o /dev/null --max-time 2 "$URL/api/roster"; }
wait_up() { for _ in $(seq 1 60); do up && return 0; sleep 0.5; done; return 1; }
notify() { command -v notify-send >/dev/null && notify-send -i "$APP/public/favicon.svg" "Endfield" "$1"; echo "$1"; }

start() {
  if up; then return 0; fi
  if sc is-active --quiet "$UNIT"; then
    wait_up && return 0
  fi
  sc reset-failed "$UNIT" >/dev/null 2>&1
  systemd-run --user --quiet --unit="$UNIT" --working-directory="$APP" \
    --setenv=PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin" \
    "$NODE_BIN/npm" run dev -- --port "$PORT" --strictPort || return 1
  wait_up
}

fail() {
  notify "Server did not come up on $URL — see launch.sh log"
  journalctl --user -u "$UNIT" -n 20 --no-pager
  exit 1
}

cmd="${1:-open}"
case "$cmd" in
  open)
    start || fail
    xdg-open "$URL" >/dev/null 2>&1
    ;;
  start)
    start && echo "Calculator is up → $URL" || fail
    ;;
  stop)
    sc stop "$UNIT" 2>/dev/null && echo "Stopped" || echo "Was not running"
    ;;
  restart)
    sc stop "$UNIT" 2>/dev/null
    start && echo "Restarted → $URL" || fail
    ;;
  status)
    if ! up; then echo "stopped"; exit 0; fi
    echo "running → $URL"
    if ! sc is-active --quiet "$UNIT"; then
      echo "(server started outside the launcher — e.g. npm run dev in a terminal)"
    fi
    ;;
  log)
    journalctl --user -u "$UNIT" -f
    ;;
  *)
    sed -n '2,10p' "$0"; exit 1
    ;;
esac
