---
name: merge-change
description: Conclude a software change by validating its change workspace, following repository merge guidance, integrating the branch directly or creating a pull request as appropriate, and cleaning up the change worktree safely.
---

# Merge Change

## Purpose

Conclude an approved software change by integrating the completed change branch according to repository conventions and cleaning up the temporary change workspace.

This skill is the closure counterpart to the change-workspace setup process.

It must first validate the assumptions about the active branch, worktree, and target branch before performing any merge or pull-request activity.

## Inputs

Use the available repository and change context to determine:

- the completed change branch;
- the dedicated change worktree;
- the intended target branch;
- the primary repository checkout;
- repository-specific contribution or merge guidance;
- whether the repository expects direct merge or pull-request-based integration.

Use repository-specific instructions in preference to the defaults in this skill.

## 1. Validate the Change Workspace

Before merging anything, inspect the current repository state.

Confirm:

- the active change branch is identifiable;
- the change branch corresponds to the completed change;
- the dedicated worktree exists and is associated with the expected branch;
- the target branch can be identified;
- the repository structure is broadly consistent with the workspace assumptions used during development;
- there are no obvious uncommitted or unrelated local changes that would make integration unsafe.

Where available, use information established during workspace setup.

If the actual workspace, branch, or repository structure is materially different from what is expected, ambiguous, or unsafe to interpret:

1. stop before merging;
2. explain the discrepancy;
3. identify the decision that cannot be made safely;
4. ask the user for guidance.

Do not guess at a materially ambiguous branch or merge target.

## 2. Determine the Integration Method

Inspect the repository for applicable merge and contribution guidance.

Determine whether the expected completion mechanism is:

- direct merge into the target branch; or
- pushing the change branch and creating a Pull Request.

Repository-specific instructions override the defaults below.

### Target branch

Prefer, in order:

1. an explicitly specified target branch;
2. repository-specific contribution or merge guidance;
3. the repository's normal integration branch;
4. `main` as the fallback when no other target can be identified.

Do not assume `main` when the repository clearly uses another integration branch such as `develop`, `dev`, or an equivalent branch.

## 3. Direct Merge Flow

Use this flow when the repository does not require a Pull Request and direct integration is appropriate.

Before merging:

- confirm the change branch is in a suitable state for integration;
- confirm the intended commits are present;
- ensure the target checkout is safe to update;
- avoid overwriting or discarding unrelated local changes.

Perform the merge using the repository's normal conventions.

Do not impose a specific merge strategy such as merge commit, squash, or rebase unless repository guidance defines one.

After a successful direct merge:

1. ensure the primary repository checkout is on the target branch;
2. ensure it reflects the merged result;
3. confirm the completed change is available from the primary checkout;
4. proceed with change-workspace cleanup.

If the merge produces conflicts or reveals a materially unexpected integration problem:

- resolve straightforward conflicts when the correct resolution is clear and remains consistent with the approved change;
- stop and ask for guidance when conflict resolution would require a significant design decision or could alter unrelated behaviour.

## 4. Pull Request Flow

Use this flow when repository guidance requires or clearly expects a Pull Request.

Follow repository-specific instructions for:

- pushing the branch;
- remote naming;
- Pull Request title and description;
- target branch;
- labels, templates, or required metadata;
- validation or pre-PR requirements.

Push the completed change branch and create the Pull Request using the available repository tooling.

Do not claim that the change has been merged merely because a Pull Request has been created.

Unless repository guidance explicitly defines an automated merge workflow that this skill is expected to complete:

- treat successful Pull Request creation as the completion point for this skill;
- leave the actual PR approval and merge to the user or repository workflow;
- do not update the primary checkout as though the Pull Request were already merged.

Do not delete the branch when it is still required by an open Pull Request.

Worktree cleanup may still be performed if it is safe and does not interfere with the Pull Request workflow.

## 5. Clean Up the Change Workspace

After the integration action is complete, clean up the dedicated change workspace where appropriate.

### After direct merge

Normally:

- remove the dedicated change worktree;
- remove the local change branch when it has been successfully integrated and no repository convention requires retaining it;
- preserve any remote branch where repository policy or tooling expects it to remain;
- verify the primary checkout remains usable on the target branch.

### After Pull Request creation

Normally:

- remove the local change worktree when it is no longer needed;
- keep the change branch available for the open Pull Request;
- do not delete remote branch state required by the PR;
- do not alter the primary checkout to simulate a merge that has not happened.

Never remove a worktree or branch containing uncommitted or unintegrated work without first stopping and reporting the issue.

## 6. Completion Report

Report the final state clearly.

Include:

- source/change branch;
- target branch;
- integration method used:
  - direct merge; or
  - Pull Request;
- result of the merge or PR creation;
- Pull Request identifier or URL when applicable;
- primary checkout state;
- whether the change worktree was removed;
- whether the local change branch was removed or retained;
- any remote branch retained;
- any deviations from repository guidance or expected workspace structure;
- any unresolved condition requiring user action.

## Completion Criteria

### Direct merge

The merge activity is complete only when:

- the workspace assumptions have been validated;
- the correct target branch has been identified;
- the change branch has been integrated successfully;
- the primary checkout reflects the merged target branch;
- the dedicated worktree has been cleaned up safely;
- obsolete local change state has been removed where appropriate;
- the outcome has been reported.

### Pull Request

The merge activity is complete from this skill's perspective when:

- the workspace assumptions have been validated;
- repository PR guidance has been followed;
- the change branch has been pushed as required;
- the Pull Request has been created successfully;
- the skill has not falsely represented the change as already merged;
- safe local worktree cleanup has been performed where appropriate;
- the remaining user or repository action has been clearly reported.

If repository rules require additional steps beyond this skill, report them explicitly rather than inventing or bypassing them.
