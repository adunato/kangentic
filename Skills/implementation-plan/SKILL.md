---
name: implementation-plan
description: Turn an approved high-level design into a practical implementation plan, including a decision on whether a separate low-level design is required.
---

# Implementation Plan

## Purpose

Turn an approved High-Level Design into a practical plan for implementing the change.

The implementation plan should bridge the gap between architecture and development. It should explain how the change will be approached, in what order, what parts of the system are affected, and how the finished implementation will be validated.

Use the template in `references/implementation-plan-template.md`.

## Approach

Before writing the implementation plan:

1. Read the approved HLD and all relevant supporting context.
2. Inspect the repository where necessary to understand the existing implementation.
3. Confirm that the proposed HLD is compatible with the actual codebase.
4. Identify implementation dependencies, sequencing constraints, and areas of uncertainty.
5. Decide whether the change requires a separate Low-Level Design.

Do not silently redesign the approved HLD.

If repository inspection reveals a material conflict with the HLD, surface it clearly before proceeding rather than inventing a different solution.

## Level of Detail

The implementation plan should be concrete enough to guide development without becoming a patch specification.

It should:

- identify the main areas of the codebase that will change;
- describe the logical units of work;
- describe the expected order of implementation where sequencing matters;
- explain important dependencies between pieces of work;
- identify relevant validation and testing requirements;
- explicitly decide whether an LLD is required.

The plan may mention specific components, modules, directories, or known files where this improves clarity.

Do not repeat architectural detail already captured in the HLD unless it directly constrains implementation.

Do not attempt to describe every individual file change unless that detail is genuinely useful. Detailed file-by-file design belongs in the Low-Level Design when one is required.

Keep the plan practical and concise. Avoid project-management terminology, estimates, story points, staffing assumptions, governance language, and unnecessary ceremony.

## Low-Level Design Decision

Every implementation plan must explicitly state whether a separate LLD is required.

An LLD is normally appropriate when implementation requires significant codebase-specific design before development can safely begin.

Consider an LLD when one or more of the following apply:

- the change spans several interconnected areas of the codebase;
- existing architecture must be understood in detail before modifying it;
- important behaviour depends on interactions between multiple files or components;
- the HLD leaves meaningful implementation choices unresolved;
- new interfaces, state transitions, data structures, or internal contracts require detailed design;
- implementation order is sensitive or carries meaningful regression risk;
- a developer would otherwise need to discover and design substantial parts of the solution while coding.

An LLD is usually unnecessary when:

- the implementation path is straightforward from the HLD;
- the affected code is narrow and well understood;
- the detailed solution can safely be determined during normal development;
- a separate file-level design document would mostly repeat the implementation plan.

The decision should be a judgement call based on complexity, not a mechanical scoring exercise.

## Output

Create the implementation plan as a Markdown document using `references/implementation-plan-template.md`.

Adapt the template to the change:

- remove sections that genuinely do not apply;
- add small subsections where they materially improve clarity;
- avoid boilerplate;
- keep tasks concrete and implementation-oriented.

Before completing the plan, check that:

- the implementation approach is consistent with the approved HLD;
- the major areas of work are identified;
- important dependencies and sequencing are clear;
- validation expectations are clear enough to guide later testing;
- the LLD decision is explicit and justified;
- a developer could begin the next stage without having to reconstruct the implementation strategy from scratch.
