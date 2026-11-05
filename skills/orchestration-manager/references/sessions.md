# Sessions reference

How Claude Code sessions behave when you launch, resume, watch and move them, and the failure modes that look like success. SKILL.md (Spawning, Schedule, Tick step 3) points here. `claude` means your launcher, as in SKILL.md.

## Launching

- **Trust.** A session started or resumed in a directory the launcher's profile has never trusted fails with "Workspace not trusted". You can't set the trust flag yourself (editing settings is Self-Modification), and the CLI's hint may name the wrong profile. Launch from a directory that profile already trusts, such as the main checkout with `-w <worktree>`, or post a `blocker` asking the user to open the new directory once with that launcher.
- **Title.** `-n "<ID> <short name>"` sets only the local name that `claude agents` shows. The Claude app generates its own title from the first prompt, and resumes, forks and moves can change it again. When the app list should show the manager's ID, run `/rename "<ID> <short name>"` inside the session after each launch, resume, fork or move (local conventions may name a script that does it).

## Resuming and waking

- **Full id only.** `--resume` takes the full lowercase session id. A short id either starts a copy under a new id or opens the conversation picker, where a `--bg` session sits on "Loading conversations…" with no transcript. After every resume, check that the transcript got a new turn.
- **Flags start a copy.** `--permission-mode`, `-n` or `--model` on a resume start a copy, and so does resuming a session that is still running. Resume with the id and the message only.
- **Listed with a live pid means alive.** A session in `claude agents --json` whose `pid` is still that session's process (running, and on Linux started at the `procStart` its `<config>/sessions/<pid>.json` records, since pids get reused) is alive, whatever its status says (`done` means idle, not exited): use SendMessage. After a reboot, entries stay listed with no process; those you resume (After a restart or reboot). When SendMessage can't reach it (it runs under another launcher profile, or holds messages for approval), `claude stop <id>`, check that its process has exited, then `claude --bg --resume <full id> "<message>"`: that continues in place.
- **Match by id.** Sessions get renamed, and a session started under one launcher profile appears only in that profile's `agents` list. List every profile local conventions name.
- **Several launcher profiles.** Before resuming a session under another profile, check that profile's `agents --json` for a stale entry with the same id. With one, a resume with flags starts a copy and a flagless resume continues in the stale entry's saved cwd. Resume without flags, or accept the copy and record the new id. Don't `rm` the old entry: `rm` deletes the worktree, which the copy may be using.

## Liveness

A session's listed state says little about whether it is working. Judge it by:

- **The last timestamped assistant turn** in its transcript, not the file's mtime: cost and state lines keep touching the file while the session sits on a dead subagent.
- **Its newest subagent transcript** (`subagents/*.jsonl` beside the session's transcript) and **live processes** (`ps` for its test and build commands). A manager can be listed as running after its processes died, for instance after the machine ran out of memory.
- **Limit messages.** "You've hit your session limit", a weekly usage limit or a monthly spend limit leaves the session listed as blocked with a live process, and it never wakes on its own. A spend limit stops every session on that account, and recurring jobs keep failing against it. Grep transcripts for these, message the session after the reset (it is still listed, so SendMessage, not a resume, which would fork it), and post the spend-limit case to the user, who has to raise the limit or move the work to another account.

A manager waiting on a notification from a subagent or background command that was killed (a reboot, a limit, memory pressure) never wakes. The sweep flags a manager whose last assistant turn and newest subagent transcript are both quiet for more than 20 minutes while no test or build process of its is running. Nudge it with a message saying what to re-check: SendMessage while it is listed, a resume only once its process is gone (Resuming and waking).

## After a restart or reboot

- **Container or Claude restart.** Your own pid changes. The repo's `heartbeat.sh` follows the session to its new pid through `<config>/sessions/*.json`; an older copy exits with "pid gone". Look up your new pid there (match `sessionId`), restart the heartbeat with it if it isn't running, then re-arm the ticker and the wait. Managers' `--bg` sessions usually survive a container restart.
- **Machine reboot.** It kills the `--bg` managers too. `claude agents` lists them as blocked with no process, which looks the same as a limit pause, so check the transcript. Resume each with `claude --bg --resume <full id> "<message>"` from its worktree, and tell it to re-check its git state, any subagents it was waiting on, and containers or test databases it had running.

## Moving a session between machines

Teleporting a session that is still running on another machine brings no history: it starts a second, empty session while the original keeps going. To move one, message the original to finish its step, push, write a handoff note and stop; then start the new session from the handoff. A teleported copy's transcript appears only after its first turn, and its branch may not be on the remote yet.

## Shell gotchas

- **`pkill -f` can kill its own shell.** `pkill -f '<pattern>'` also matches the Bash tool's own shell, whose command line contains the pattern, and the call dies with exit 144. Wrapping it in `bash -c` doesn't help: the parent shell still matches. Bracket one character, `pkill -f '[h]eartbeat.sh <session_id>'`, so the pattern no longer matches its own text, or kill a pid you looked up with `pgrep` in an earlier call.
- **Edit running scripts by replacing them.** Write a new file and `mv` it over the old one: bash reads a script while it runs it, so an in-place edit changes what a running loop executes next.
- **The shell can change.** A resumed session may get a different login shell (bash or zsh). Wrap multi-word or bash-specific commands in `bash -c '…'` or a script file.
