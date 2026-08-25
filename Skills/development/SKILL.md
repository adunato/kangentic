---
name: development
description: Implement an approved software change using the available design artifacts, following the LLD where present, controlling design deviations, and completing appropriate linting, syntax, type, and build integrity checks.
---

# Development

## Purpose

Implement an approved software change using the available design and planning artifacts while preserving the intent of the approved solution.

The development stage should produce working code that is internally consistent and free from known syntax, lint, type, or build-integrity issues within the practical scope of the change.

## Inputs

Use all relevant approved artifacts that are available, including:

- High-Level Design (HLD);
- Implementation Plan;
- Low-Level Design (LLD), when one exists;
- repository-specific instructions, conventions, and development guidance;
- the current codebase and prepared change workspace.

Treat the artifacts as complementary:

- the HLD defines the intended behaviour and architectural outcome;
- the implementation plan defines the intended implementation approach;
- the LLD, when present, defines the expected file-level change design.

## Development Approach

Before making changes:

1. Read all available approved artifacts.
2. Inspect the relevant code and repository conventions.
3. Understand the intended change surface before editing.
4. Use the existing architecture and coding patterns where they remain appropriate.

Implement the change directly in the prepared change workspace.

Keep the implementation focused on the approved scope. Avoid unrelated refactoring or opportunistic cleanup unless it is required to complete the change safely.

## Following the LLD

When an approved LLD exists, use it as the primary file-level guide for development.

The implementation is expected to follow the LLD where it remains valid against the actual codebase.

### Minor deviations

A minor deviation is one that:

- does not materially change the approved behaviour or architecture;
- does not introduce a new significant design decision;
- stays within the intended scope of the change;
- is needed because the actual code differs slightly from what the LLD anticipated;
- can be resolved safely through normal engineering judgement.

For minor deviations:

- proceed with the implementation;
- make the smallest appropriate adjustment;
- record the deviation for the completion report.

### Major deviations

A major deviation is one that materially affects the approved design or implementation direction.

Examples include:

- changing the architecture described by the HLD;
- abandoning or substantially restructuring the implementation approach;
- introducing a significant new component, dependency, interface, or data model;
- discovering that the approved LLD is not viable;
- expanding the scope of the change materially;
- encountering a design decision that cannot reasonably be treated as an implementation detail.

When a major deviation is required:

1. stop before implementing the deviation;
2. explain what was discovered;
3. explain why the approved design cannot be followed as written;
4. describe the decision that needs to be made;
5. ask the user for guidance.

Do not silently implement a major deviation.

## Code Quality and Scope

During implementation:

- follow repository-specific coding and formatting conventions;
- preserve established patterns where appropriate;
- keep changes limited to what is required by the approved design;
- avoid introducing unnecessary abstractions;
- update supporting code where required for consistency;
- remove obsolete code only when its removal is directly part of the change.

Development is responsible for leaving the codebase in an internally coherent state.

## Integrity Checks

Development is not complete when the code has merely been edited.

Before completing the stage, run the relevant development-integrity checks supported by the repository.

These may include:

- linting;
- formatting checks;
- syntax validation;
- type checking;
- compilation;
- build verification;
- static analysis;
- equivalent repository-specific checks.

Use the project's established commands and tooling where available.

### Build scope

A successful integrity check must provide reasonable confidence that the changed code does not introduce syntax, compilation, type, dependency-resolution, or build errors.

Be pragmatic about build scope.

For small or moderate projects, run the normal project build when practical.

For large projects or expensive monorepos:

- prefer the smallest build, compilation, or validation target that meaningfully covers the changed area;
- use affected-package, affected-project, module-level, workspace-level, or incremental build commands where the project supports them;
- avoid running a very expensive full-repository build solely for ceremony when a narrower check provides equivalent confidence for the changed scope.

Do not reduce the check so far that meaningful syntax or compilation errors in the changed code could reasonably remain undiscovered.

If no build command exists or a build is not applicable, use the closest repository-supported syntax, type, compile, or integrity check and state what was run.

## Handling Check Failures

If an integrity check fails because of the implementation:

1. investigate the failure;
2. correct the implementation;
3. rerun the relevant check;
4. continue until the changed scope passes.

Do not treat a known implementation-caused lint, syntax, type, or build failure as acceptable completion.

If a check fails because of a clearly pre-existing or unrelated repository issue:

- verify that it is unrelated to the change where reasonably possible;
- do not alter unrelated code solely to make the check pass;
- record the failure and its apparent cause in the completion report.

## Completion Report

At the end of development, report:

- a concise summary of what was implemented;
- the important areas of the codebase changed;
- any minor deviations from the LLD or implementation plan and why they were necessary;
- confirmation that no unapproved major deviations were made;
- the integrity checks that were run;
- the scope of any build or compilation check;
- the result of each check;
- any known pre-existing or unrelated check failures.

Development is complete only when:

- the approved change has been implemented;
- any LLD has been followed or deviations have been handled according to this skill;
- relevant development-integrity checks have been completed;
- the changed scope has no known implementation-caused syntax, lint, type, compilation, or build errors;
- the implementation and any deviations have been clearly reported.
