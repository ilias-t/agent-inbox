#!/usr/bin/env bash
# Orchestrator ticker: sleeps until the next pickup slot (meta/schedule computed.next_pickup_at)
# and exits there, so the run_in_background completion wakes the orchestrator session as a tick.
# Re-launch it after every tick. The lease is heartbeat.sh's job, not this script's.
# Replaces CronCreate, which hasn't fired reliably in Remote Control sessions.
# Exit 0 at the slot (prints "TICK <slot> (in_hours=...)") or after MAX_WAIT (prints "KEEPALIVE ..."), 1 when the schedule can't be read.
# Usage: <state>/ticker.sh (full path, so heartbeat.sh can see it running)
# AGENT_INBOX_BIN overrides the CLI (default: agent-inbox on PATH), as a command line split on spaces.
# To change the running copy, write a new file and mv it over: bash reads a script while it runs it.
set -u
read -ra A <<<"${AGENT_INBOX_BIN:-agent-inbox}"

sched=$("${A[@]}" schedule show --json 2>/dev/null) || { echo "TICKER schedule read failed"; exit 1; }
in_hours=$(jq -r .computed.in_hours <<<"$sched")
next=$(jq -r .computed.next_pickup_at <<<"$sched")
target=$(date -d "$next" +%s) || { echo "TICKER bad next_pickup_at: $next"; exit 1; }

# Background commands are killed after 2h, so a long off-hours wait ends early as a
# keepalive (exit 0, "KEEPALIVE"): the orchestrator re-launches without running a tick.
MAX_WAIT=${MAX_WAIT:-6600}
left=$((target - $(date +%s)))
if (( left > MAX_WAIT )); then sleep "$MAX_WAIT"; echo "KEEPALIVE next $next"; exit 0; fi
(( left > 0 )) && sleep "$left"
# The slot may sit across a work-hours edge, so report in_hours as of now; keep the
# pre-sleep value when the re-read fails.
now=$("${A[@]}" schedule show --json 2>/dev/null | jq -r '.computed.in_hours' 2>/dev/null)
[[ $now == true || $now == false ]] && in_hours=$now
echo "TICK $next (in_hours=$in_hours)"
