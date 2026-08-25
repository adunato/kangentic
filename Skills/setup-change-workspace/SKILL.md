---
name: setup-change-workspace
description: Prepare or adopt an isolated Git workspace for a change by establishing a safe branch and worktree while respecting repository-specific conventions.
---

# Setup Change Workspace

## Purpose

Prepare an isolated Git workspace for a change before implementation begins.

Be repository-aware first and opinionated second: follow established repository conventions when they exist, and use the defaults below only when no applicable convention is defined.

## Inputs

Use the available task context to determine:

- the intent of the change;
- the repository being modified;
- the appropriate base branch;
- any existing branch, worktree, contribution, or repository-specific conventions;
- whether a suitable branch or worktree has already been created by the surrounding execution environment.

Do not require a particular task-management system, orchestration tool, or hosting platform.

## Procedure

### 1. Inspect repository conventions

Before creating or renaming anything, inspect the repository for instructions governing branch naming, worktree usage or location, base branch selection, contribution workflow, and repository setup.

Follow applicable project or repository conventions in preference to the defaults in this skill.

### 2. Determine the base branch

Identify the appropriate base branch for the change.

Prefer an explicitly specified base branch or an established repository convention. Otherwise use the repository's normal integration branch.

Confirm that the selected base is suitable for the task before creating the change branch.

Do not destructively reset, rewrite, or otherwise disturb unrelated local work merely to update the base branch.

### 3. Create or adopt the change branch

If a suitable branch has already been created for the task, adopt and validate it rather than creating a duplicate.

When no repository-specific naming convention exists, use:

`change/<short-descriptive-name>`

For `<short-descriptive-name>`:

- describe the purpose of the change rather than implementation mechanics;
- use lowercase words separated by hyphens;
- keep the name concise but distinguishable;
- avoid spaces and unnecessary special characters.

Example:

`change/add-customer-search`

### 4. Create or adopt the worktree

Use a dedicated Git worktree for the change when worktrees are supported and appropriate for the environment.

If the execution environment has already created a suitable worktree for the task, adopt it rather than creating another one.

When creating a new worktree and no repository-specific location convention exists:

- place it outside the primary repository checkout;
- prefer a predictable sibling or dedicated worktree directory;
- associate it with the change branch;
- avoid placing worktree directories inside the tracked repository tree.

Do not create duplicate worktrees for the same change without a clear reason.

### 5. Validate the workspace

Before completing setup, verify that:

- the intended branch is checked out in the dedicated worktree;
- the branch is based on the intended base branch;
- the worktree is in a usable state for development;
- unrelated local changes have not been overwritten, discarded, or moved;
- subsequent work can safely occur in the dedicated worktree rather than the primary checkout.

Do not use destructive Git operations to force the workspace into compliance unless explicitly instructed.

## Output

Report:

- the branch name;
- the worktree location;
- the base branch;
- whether the branch/worktree were created or adopted;
- any relevant repository convention that affected the setup;
- any condition that prevents the workspace from being considered ready.

The workspace is ready only when subsequent development can proceed safely in the isolated change environment.
