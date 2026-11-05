#!/usr/bin/env bash
# Orchestrator heartbeat: renews the agent-inbox lease every 5 minutes during work hours
# for as long as the orchestrator's Claude process is alive. Independent of the orchestrator's
# turns, so an orchestrator waiting on a question or busy mid-turn still shows as up.
# Tied to the process: when the orchestrator exits, the heartbeat stops and the lease
# lapses, so "orchestrator may be down" stays truthful.
# Usage: nohup <state>/heartbeat.sh <holder_session_id> <manager_pid> >/dev/null 2>&1 &
# Run the copy in the orchestrator's state directory; ORCH_DIR overrides it (default: this
# script's directory). AGENT_INBOX_BIN overrides the CLI (default: agent-inbox on PATH); it is
# a command line split on spaces, e.g. AGENT_INBOX_BIN="node /path/to/agent-inbox/bin/agent-inbox.mjs".
set -u
SESSION=$1 PID=$2
ORCH_DIR=$(cd "${ORCH_DIR:-$(dirname "$0")}" && pwd) || exit 2
read -ra A <<<"${AGENT_INBOX_BIN:-agent-inbox}"
LOG=$ORCH_DIR/heartbeat.log
# pgrep -f takes a regex: match the ticker's path literally.
TICKER_RE=$(sed 's/[][\.*^$+?(){}|]/\\&/g' <<<"$ORCH_DIR/ticker.sh")
# An empty session would make every renew a usage error (exit 2): refuse to start.
[[ -n $SESSION ]] || { echo "$(date -u +%FT%TZ) empty holder_session_id, not starting" | tee -a "$LOG" >&2; exit 2; }
# Loop watch: the heartbeat outlives the orchestrator's ticker and wake (Claude Code reaps
# background jobs under memory pressure), so a live lease can hide a dead loop. When no
# ticker.sh has run for two checks in a row (~10 min) in work hours, say so once in the
# digest, so the inbox card shows "loop down" instead of an unexplained "tick overdue".
misses=0 flagged=0
while kill -0 "$PID" 2>/dev/null; do
  if [[ $("${A[@]}" schedule show --json 2>/dev/null | jq -r .computed.in_hours) == true ]]; then
    out=$("${A[@]}" lease renew --session "$SESSION" --json 2>&1); rc=$?
    if [[ $rc == 3 ]]; then echo "$(date -u +%FT%TZ) lease lost, stopping: $out" >>"$LOG"; exit 3; fi
    [[ $rc == 0 ]] || echo "$(date -u +%FT%TZ) renew failed rc=$rc" >>"$LOG"
    if pgrep -f "$TICKER_RE" >/dev/null; then
      misses=0 flagged=0
    else
      misses=$((misses + 1))
      if (( misses >= 2 && flagged == 0 )); then
        since=$(date -u -d "-$((misses * 5)) min" +%H:%M)
        msg="**Orchestrator loop down since ~${since} UTC.** Its ticker isn't running (most likely reaped under memory pressure), so no pickups or sweeps happen; the heartbeat still holds the lease. Tell the orchestrator to restart its loop, or it restarts itself at its next turn."
        if AGENT_INBOX_SESSION=$SESSION "${A[@]}" meta set manager --set "digest=$msg" --json >/dev/null 2>&1; then flagged=1; fi
        echo "$(date -u +%FT%TZ) ticker missing for $misses checks, flagged=$flagged" >>"$LOG"
      fi
    fi
  fi
  sleep 300
done
echo "$(date -u +%FT%TZ) manager pid $PID gone, stopping" >>"$LOG"
