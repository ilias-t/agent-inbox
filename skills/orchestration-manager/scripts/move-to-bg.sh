#!/usr/bin/env bash
# Moves a foreground (terminal/tmux) Claude session into a daemon-managed background
# session under the same id, so it survives the terminal closing. Run it detached
# from inside the session; it waits for the session's turn to end, stops the
# foreground process, then resumes the session with --bg.
# Usage: setsid nohup move-to-bg.sh <session_id> <pid> <cwd> <name> [prompt_file] >/dev/null 2>&1 & disown
# CLAUDE_BIN picks the launcher (default: claude; set it to the wrapper you run agents with,
# e.g. one that sets CLAUDE_CONFIG_DIR for a second account). ORCH_DIR is where the log goes
# (default: this script's directory, the orchestrator's state directory).
set -u
ID=$1 PID=$2 DIR=$3 NAME=$4 PROMPT_FILE=${5:-}
BIN=${CLAUDE_BIN:-claude}
ORCH_DIR=$(cd "${ORCH_DIR:-$(dirname "$0")}" && pwd) || exit 2
LOG=$ORCH_DIR/move-to-bg.log
log() { echo "$(date -u +%FT%TZ) $*" >>"$LOG"; }

status() { "$BIN" agents --json 2>/dev/null | jq -r --arg id "$ID" '.[] | select(.sessionId == $id) | .status' | head -1; }

# Wait (up to 30 min) until the turn that launched us has ended: two idle reads 5s apart.
log "waiting for $ID (pid $PID) to go idle"
idle=0
for _ in $(seq 360); do
  kill -0 "$PID" 2>/dev/null || break
  if [[ $(status) == idle ]]; then idle=$((idle + 1)); else idle=0; fi
  [[ $idle -ge 2 ]] && break
  sleep 5
done
if [[ $idle -lt 2 ]] && kill -0 "$PID" 2>/dev/null; then log "never went idle, giving up"; exit 1; fi

if kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID"
  for _ in $(seq 30); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
  kill -0 "$PID" 2>/dev/null && { log "pid $PID ignored TERM, killing"; kill -KILL "$PID"; sleep 2; }
fi
log "foreground pid $PID stopped"

cd "$DIR" || { log "cannot cd $DIR"; exit 1; }
args=(--bg --resume "$ID" -n "$NAME" --permission-mode auto)
if [[ -n $PROMPT_FILE && -s $PROMPT_FILE ]]; then
  out=$("$BIN" "${args[@]}" "$(cat "$PROMPT_FILE")" 2>&1); rc=$?
else
  out=$("$BIN" "${args[@]}" 2>&1); rc=$?
fi
log "resume rc=$rc: $out"
[[ $rc == 0 ]] || log "FAILED: resume by hand with: cd $DIR && $BIN --resume $ID"
