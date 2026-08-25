---
name: high-level-design
description: Produce a pragmatic high-level design from a clarified software requirement, using the bundled HLD template.
---

# High-Level Design

## Purpose

Turn a clarified software requirement into a concrete high-level design that can be used as the basis for implementation planning.

The HLD should explain:

- what needs to change;
- why it needs to change;
- what the expected outcome is;
- how the solution should work at an architectural level;
- how relevant backend and user-interface behaviour should change.

Use the template in `references/hld-template.md`.

## Approach

Before writing the HLD:

1. Read the requirement and all relevant supplied context.
2. Inspect the existing system or repository where necessary to understand the current architecture and behaviour.
3. Identify ambiguities that materially affect the design.
4. If important information is missing, ask for clarification rather than inventing requirements.

When writing the HLD:

- use simple, concrete language;
- avoid corporate or project-management jargon;
- re-articulate the requirements clearly rather than relying on the original request being available;
- distinguish current behaviour from the proposed behaviour;
- make clear architectural decisions where the available information supports them;
- describe backend and UI changes sufficiently for someone to understand the intended solution;
- describe interfaces, data flows, state changes, integrations, and dependencies where they matter;
- focus on behaviour and architecture rather than individual source files;
- do not produce patches, diffs, line-level changes, or a low-level implementation design;
- avoid speculative complexity and unnecessary abstractions;
- omit irrelevant detail rather than filling the document with boilerplate.

The design should be opinionated enough to guide the implementation plan while leaving detailed code-level decisions to later stages.

## Output

Create the HLD as a Markdown document using `references/hld-template.md`.

Adapt the template to the change:

- remove sections that genuinely do not apply;
- add small subsections where they materially improve clarity;
- do not add sections merely to make the document appear more complete.

Before completing the HLD, check that:

- the requirement can be understood without referring back to the original request;
- the expected outcome is unambiguous;
- the proposed design clearly explains how the system will change;
- backend implications are covered where applicable;
- UI and user-flow implications are covered where applicable;
- important architectural decisions and constraints are explicit;
- unresolved questions are clearly identified;
- the document contains enough information to produce an implementation plan.
