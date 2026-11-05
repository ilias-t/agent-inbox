# Project conventions template

One file per repo the orchestrator delegates work in, at `<state>/projects/<repo>.md`, where `<state>` is the orchestrator's state directory (SKILL.md) and `<repo>` the checkout's directory name. It lives beside the registry, outside any repo, because it is yours, not the project's. The orchestrator pastes the **Conventions** section into every brief for that repo (brief-template.md, "Project conventions") and reads **Orchestrator notes** itself.

A missing section means the default in brackets. A repo without a file gets every default.

```markdown
# <repo>

- Main checkout: <path the orchestrator launches managers from> [the repo containing the current directory]
- Default branch: <develop | main | ...> [from `gh repo view --json defaultBranchRef`]

## Conventions

1. Before working: <files to read (AGENTS.md, rules), setup scripts to run in the worktree> [read AGENTS.md or CLAUDE.md if present]
2. Tickets: <tracker and naming, e.g. "Linear, branch `<ticket-id>-<slug>`; create the ticket first"> [no tracker: branch `o<N>-<slug>`, the PR is the record]
3. Tests: <how to run them, test databases or services to use, what counts as a false green> [the repo's documented test command]
4. Shared resources: <what a manager must never touch, e.g. the main checkout's docker compose stack> [none]
5. Shipping: <how to push and open the PR, e.g. Graphite `gt submit`; title and body conventions> [`git push` + `gh pr create`]
6. Pre-push review: <skill or command to run> [a review subagent or `/code-review`]
7. Reviewers: <who to request, and how (reviewers or assignees); anyone never to request> [none: leave it to the user]
8. Merge: <"conservative" (the manager stops at a ready PR and the user merges), or the repo's merge path when it isn't `gh pr merge --squash`, e.g. a merge-queue label; plus what deploys on merge and its rollback command> [self-merge allowed under brief contract item 4's conditions]
9. Per-session resources to clean up before finishing: <e.g. throwaway test DB and its container> [none]

## Orchestrator notes

- CI checks to ignore: <check name and why, e.g. an approval gate that reports as failing> [none]
- Usual CI duration: <e.g. "integration tests ~25 min"; the sweep flags runs far past it> [none: don't flag]
- Leftovers to check on cleanup: <e.g. `docker ps -a` containers named after the worktree> [none]
```
