---
name: low-level-design
description: Produce a concise, file-level technical design from an approved HLD and implementation plan after inspecting the actual codebase.
---

# Low-Level Design

## Purpose

Translate an approved High-Level Design and implementation plan into a concrete file-by-file description of the code changes required.

The LLD is the final design step before development. It should remove the need for the developer to rediscover the structure of the solution while implementing it.

Use the template in `references/lld-template.md`.

## Inputs

Use:

- the approved HLD;
- the approved implementation plan;
- the current repository and codebase;
- any relevant repository-specific instructions or conventions.

The HLD defines what the solution should achieve.

The implementation plan defines the intended implementation approach.

The repository determines how that approach maps onto the actual code.

## Approach

Before writing the LLD:

1. Read the HLD and implementation plan.
2. Explore the relevant areas of the repository.
3. Trace the existing implementation sufficiently to understand how the proposed change fits into it.
4. Identify every existing file that must be modified.
5. Identify any files that need to be created, moved, or removed.
6. Identify important dependencies between those changes.

Do not simply infer filenames from the HLD. Verify the actual repository structure and implementation.

If repository exploration reveals a material conflict with the HLD or implementation plan, surface it rather than silently redesigning the solution.

## Level of Detail

The LLD should be file-aware and implementation-specific.

For every affected file, explain:

- what responsibility in that file is changing;
- what behaviour or structure needs to be added, modified, or removed;
- relevant functions, classes, components, types, handlers, or other code structures where useful;
- how the change interacts with other affected files where that is not obvious.

Code snippets may be included when they make the intended design substantially clearer.

Snippets should illustrate structure, interfaces, signatures, data shape, or important logic.

Do not:

- produce a diff;
- specify line numbers;
- reproduce large blocks of existing code;
- prescribe every individual statement to be written;
- repeat requirements or architectural explanation already captured in the HLD;
- repeat the implementation plan unnecessarily.

The LLD should describe what needs to change in each file, not pre-write the implementation.

## Completeness

The file inventory should be complete enough that development should not normally discover additional planned files simply because the design failed to inspect the repository properly.

Incidental files discovered during implementation may still occur, but the significant expected change surface should be represented.

Include test files only when creating or modifying them is part of the planned implementation. Do not invent test-file changes solely to make the document appear complete.

## Output

Create the LLD as a Markdown document using `references/lld-template.md`.

Keep it concise.

Prefer specific file-level descriptions over general technical discussion.

Before completing the LLD, check that:

- the actual repository has been inspected;
- all significant expected file changes are represented;
- each file entry clearly explains the intended change;
- new files and removed files are identified where applicable;
- important cross-file dependencies are clear;
- snippets are illustrative rather than patch-level;
- the document does not unnecessarily repeat the HLD or implementation plan;
- a developer can begin implementation without first having to design the file-level solution.
