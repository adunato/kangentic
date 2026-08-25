---
name: validation
description: Validate an implemented software change through comprehensive automated testing, actively rectify defects found during validation, and minimize remaining manual user validation.
---

# Validation

## Purpose

Validate that an implemented change behaves as intended, has not introduced regressions, and is corrected when validation uncovers defects.

Validation is automation-first and corrective.

The goal is to:

- determine the appropriate validation scope;
- add or extend automated tests where needed;
- execute change-specific and regression validation;
- fix defects identified during validation;
- rerun affected validation after fixes;
- leave the user with only the manual checks that genuinely cannot be automated.

## Inputs

Use all relevant available context, including:

- High-Level Design (HLD);
- Implementation Plan;
- Low-Level Design (LLD), when present;
- implementation summary;
- the completed code changes;
- existing repository testing conventions and tooling.

Use the design artifacts to understand intended behaviour.

Use the repository to determine how that behaviour should be tested.

## 1. Assess the Validation Scope

Before running tests, determine what validation the change requires.

Inspect:

- the changed code;
- existing unit tests;
- existing integration tests;
- existing end-to-end tests;
- existing regression suites;
- project test configuration;
- relevant scripts and test commands;
- validation requirements identified in the HLD or implementation plan.

Identify:

- behaviours introduced or changed;
- existing behaviours that could regress;
- important edge cases;
- error conditions;
- relevant user flows;
- integration boundaries affected by the change.

Do not assume that existing tests are sufficient merely because they pass.

Create a validation approach specifically for the implemented change.

## 2. Create or Extend Automated Tests

Add or update tests necessary to validate the change.

Follow the project's existing testing conventions and tools wherever possible.

### Unit Tests

Create or extend unit tests for behaviour that can be validated in isolation.

Unit tests should cover, where relevant:

- new behaviour;
- changed behaviour;
- important branches and conditions;
- error handling;
- edge cases;
- state transitions;
- regression scenarios directly related to the change.

Avoid tests that merely duplicate implementation details without proving useful behaviour.

### End-to-End Tests

Create or extend end-to-end tests for important user or system flows where the project supports them.

Use the project's existing E2E framework, such as Playwright or an equivalent tool.

End-to-end tests should validate meaningful behaviour across the relevant system boundaries.

Where applicable, cover:

- primary successful workflows;
- important alternate paths;
- validation and error states;
- user-visible state changes;
- persistence across interactions;
- integration between UI and backend behaviour.

Prefer deterministic tests that can run repeatedly without unnecessary manual setup.

### Other Automated Validation

Use integration, API, component, contract, migration, or other forms of automated testing where they are more appropriate than either unit or end-to-end testing.

Use judgement based on the architecture and existing project structure.

## Projects Without Existing Test Infrastructure

The validation approach must reflect the repository's actual capabilities.

If unit or end-to-end testing infrastructure does not exist:

1. determine whether suitable automated validation can reasonably be introduced;
2. prefer lightweight approaches consistent with the project's technology and structure;
3. do not introduce a large or disproportionate testing framework solely to satisfy this skill;
4. do not default immediately to manual testing merely because automated tests do not already exist.

Where useful automation cannot reasonably be added within the scope of the change, explicitly record the limitation and the resulting manual validation requirement.

## 3. Execute Change-Specific Tests

Run the tests created or modified specifically for the change first.

This provides a focused feedback loop before broader regression testing.

Run the relevant:

- unit tests;
- integration tests;
- component tests;
- API tests;
- end-to-end tests;
- other change-specific automated checks.

## 4. Rectify Issues Found During Validation

Validation is responsible not only for identifying defects, but for correcting them where doing so remains within the approved scope and design.

When a test or automated validation step identifies an issue:

1. investigate the failure;
2. determine whether the cause is:
   - an implementation defect;
   - an incorrect or incomplete test;
   - a pre-existing repository failure;
   - an environment or infrastructure problem;
   - an intermittent or non-deterministic issue;
3. fix implementation defects that can be corrected without materially changing the approved design;
4. correct tests when the test itself is demonstrably wrong;
5. rerun the affected validation after each fix;
6. continue until the relevant validation passes or a genuine blocking condition is reached.

Do not weaken, remove, skip, or bypass a valid test merely to obtain a passing result.

Do not leave straightforward implementation defects for the user to resolve later.

### When to stop and escalate

Stop validation and report back to the user when the issue materially calls the implementation or approved design into question.

Examples include:

- the implementation cannot satisfy the approved HLD without a significant redesign;
- the LLD or implementation plan is fundamentally incompatible with the actual codebase;
- fixing the issue requires a major architectural change;
- the required behaviour is internally contradictory;
- validation exposes a major scope expansion;
- a critical dependency or assumption is invalid;
- a safe fix requires a decision that should not be made as a normal validation detail.

When stopping:

- explain the issue clearly;
- explain what validation revealed;
- identify why normal rectification is insufficient;
- describe the decision or redesign required;
- ask the user for guidance.

Do not silently perform a major redesign during validation.

## 5. Execute Regression Tests

After change-specific validation succeeds, run the relevant existing regression suites.

Use the repository's established test commands and structure.

The purpose is to detect unintended effects outside the directly changed behaviour.

Where practical, run the complete relevant test suite.

For very large projects or monorepos, use judgement:

- run all suites materially affected by the change;
- use affected-project or affected-package testing where supported;
- include broader regression coverage when shared components or cross-cutting behaviour were changed;
- avoid extremely expensive unrelated suites when they provide negligible additional confidence.

Do not narrow regression scope merely for convenience.

The chosen scope should provide reasonable confidence that the change has not broken existing behaviour.

If regression testing identifies an implementation-caused defect, return to the rectification process, fix the issue, rerun the directly affected tests, and then rerun the relevant regression coverage.

## Manual Validation

After automated validation and rectification are complete, identify anything that still requires user validation.

Manual validation should be the exception, not the default.

Before declaring something manual, consider whether it can reasonably be automated using:

- existing test frameworks;
- Playwright or equivalent browser automation;
- API or integration tests;
- test fixtures;
- scripted environment setup;
- programmatic assertions.

Do not transfer validation work to the user simply because automation requires additional effort.

Manual checks are appropriate where validation genuinely depends on things such as:

- subjective visual judgement;
- human usability assessment;
- physical devices or external environments unavailable to automation;
- credentials or services inaccessible to the test environment;
- behaviour that cannot reliably be reproduced programmatically.

Keep the remaining manual validation steps precise and minimal.

## Completion Report

At the end of validation, provide a concise but complete report.

### Validation Performed

List:

- new or updated automated tests;
- test types used;
- behaviours covered;
- relevant test files or suites;
- regression suites executed;
- the scope of regression coverage.

### Validation Results

Report:

- change-specific test results;
- regression results;
- pass/fail outcomes;
- any excluded suites and why.

### Fixes Applied During Validation

List every meaningful fix made as a result of validation.

For each fix, briefly state:

- the issue found;
- the cause;
- the correction made;
- the validation rerun to confirm the fix.

If no fixes were required, state that explicitly.

### Outstanding Failures

List any unresolved failures and clearly distinguish:

- implementation failures;
- pre-existing failures;
- environment or infrastructure failures;
- intermittent failures.

Implementation-caused failures must not remain unresolved unless validation has been stopped because they expose a major design or implementation contradiction.

### Manual Validation Required

List any checks that still require user validation and explain why they could not reasonably be automated.

If none remain, explicitly state:

`No additional manual validation is required.`

## Completion Criteria

Validation is complete only when:

- the required validation scope has been assessed;
- appropriate automated tests have been created or extended;
- new and changed behaviour is covered appropriately;
- change-specific tests pass;
- relevant regression suites have been executed;
- implementation defects found during validation have been corrected where they do not require major redesign;
- affected validation has been rerun after fixes;
- remaining failures are understood and reported;
- manual validation has been reduced to the minimum genuinely necessary;
- the final report clearly records both validation performed and fixes applied.

Validation is not complete if a known implementation-caused defect remains unresolved unless the process has explicitly stopped because resolving it requires user guidance on a major design or scope decision.
