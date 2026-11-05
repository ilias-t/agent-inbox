#!/usr/bin/env bash
# Orchestrator heartbeat: renews the agent-inbox lease every 5 minutes during work hours
# for as long as the orchestrator's Claude process is alive. Independent of the orchestrator's
# turns, so an orchestrator waiting on a question or busy mid-turn still shows as up.
# Tied to the session: when the orchestrator's process exits and no new process has taken
# over its session (a resume or daemon restart gives it a new pid, which the heartbeat
# follows through <config>/sessions/*.json), the heartbeat stops and the lease lapses, so
# "orchestrator may be down" stays truthful.
# Usage: nohup <state>/heartbeat.sh <holder_session_id> <manager_pid> >/dev/null 2>&1 &
# Run the copy in the orchestrator's state directory; ORCH_DIR overrides it (default: this
# script's directory). AGENT_INBOX_BIN overrides the CLI (default: agent-inbox on PATH); it is
# a command line split on spaces, e.g. AGENT_INBOX_BIN="node /path/to/agent-inbox/bin/agent-inbox.mjs".
# CLAUDE_CONFIG_DIR picks the launcher's config dir for the session lookup (default: ~/.claude).
# To change the running copy, write a new file and mv it over: bash reads a script while it runs it.
set -u
SESSION=$1 PID=$2
ORCH_DIR=$(cd "${ORCH_DIR:-$(dirname "$0")}" && pwd) || exit 2
read -ra A <<<"${AGENT_INBOX_BIN:-agent-inbox}"
LOG=$ORCH_DIR/heartbeat.log
# pgrep -f takes a regex: match the ticker's path literally.
TICKER_RE=$(sed 's/[][\.*^$+?(){}|]/\\&/g' <<<"$ORCH_DIR/ticker.sh")
# An empty session would make every renew a usage error (exit 2): refuse to start.
[[ -n $SESSION ]] || { echo "$(date -u +%FT%TZ) empty holder_session_id, not starting" | tee -a "$LOG" >&2; exit 2; }
SESSIONS_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions
# A process's start time in clock ticks (/proc/<pid>/stat field 22), which Claude Code records
# as procStart; empty without /proc. The comm field can hold spaces, so cut after its ")".
proc_start() { [[ -r /proc/$1/stat ]] && sed 's/.*) //' "/proc/$1/stat" | awk '{print $20}'; }
# The session's live pid from <config>/sessions/*.json. A pid counts only when it is alive and,
# when both sides are known, started at the recorded procStart: a stale file's pid may be reused.
find_pid() {
  local f line p want got
  for f in "$SESSIONS_DIR"/*.json; do
    [[ -e $f ]] || continue
    line=$(jq -r --arg s "$SESSION" 'select(.sessionId == $s) | "\(.pid) \(.procStart // "")"' "$f" 2>/dev/null) || continue
    read -r p want <<<"$line"
    [[ -n $p ]] && kill -0 "$p" 2>/dev/null || continue
    got=$(proc_start "$p")
    [[ -z $want || -z $got || $want == "$got" ]] || continue
    echo "$p"; return 0
  done
  return 1
}
# The tracked pid is the same process while it lives and keeps the start time it had when we
# took it (no /proc: kill -0 alone).
PID_START=$(proc_start "$PID")
same_pid() { kill -0 "$PID" 2>/dev/null && [[ -z $PID_START || $(proc_start "$PID") == "$PID_START" ]]; }
# Alive while that process lives; when it's gone, follow the session to its new process (a
# resume or daemon restart), looking for a minute while the session file is rewritten.
alive() {
  same_pid && return 0
  local p i
  for i in 0 1 2 3 4 5 6; do
    (( i > 0 )) && sleep 10
    if p=$(find_pid); then
      echo "$(date -u +%FT%TZ) pid $PID gone, following session $SESSION to pid $p" >>"$LOG"
      PID=$p PID_START=$(proc_start "$p"); return 0
    fi
  done
  return 1
}
# Loop watch: the heartbeat outlives the orchestrator's ticker and wake (Claude Code reaps
# background jobs under memory pressure), so a live lease can hide a dead loop. When no
# ticker.sh has run for two checks in a row (~10 min) in work hours, say so once in the
# digest, so the inbox card shows "loop down" instead of an unexplained "tick overdue".
misses=0 flagged=0
while alive; do
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
echo "$(date -u +%FT%TZ) session $SESSION has no live process (last pid $PID), stopping" >>"$LOG"
