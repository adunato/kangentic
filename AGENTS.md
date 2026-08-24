# Project contribution instructions

## Commit and push policy

- Commit every completed change as soon as it is finished and verified.
- Push each commit to the current branch's configured upstream immediately after committing.
- In the chat, confirm the commit hash, commit message, and push result before reporting the change as complete.
- Before committing, inspect the worktree and stage only files belonging to the completed change; preserve unrelated user work.
- If a commit or push cannot be completed, report the exact blocker and the affected files instead of claiming completion.

## Issue lookup and change-request artifacts

- Query GitHub issues against the configured origin fork, `adunato/kangentic`, by default. `Kangentic/kangentic` is the upstream project when upstream context is relevant.
- Store design artifacts for each applicable change in one incrementally numbered folder under `change_requests/`, named `change_requests/CR-XXX-name/`.
- A change-request folder may contain the high-level design (HLD), implementation plan, and optional low-level design (LLD). Use the installed `high-level-design`, `implementation-plan`, and `low-level-design` skills as the guidance source for those artifacts.
