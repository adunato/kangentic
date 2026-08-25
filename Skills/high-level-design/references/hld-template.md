# High-Level Design: <change name>

## 1. Summary

Briefly describe the change and the problem it solves.

Explain the intended outcome in plain language.

Keep this section short enough that someone can understand the purpose of the change without reading the rest of the document.

---

## 2. Current State

Describe how the relevant part of the system works today.

Focus only on behaviour and architecture that matters to this change.

Include, where relevant:

- current user behaviour;
- current backend behaviour;
- existing components or services involved;
- existing data flow or state;
- limitations or problems being addressed.

Make the starting point clear enough that the proposed change can be understood as a difference from the current system.

---

## 3. Requirements

Restate the requirements in clear and concrete terms.

The HLD must be understandable without requiring the reader to refer back to the original task, issue, conversation, or request.

### Functional Requirements

- <required behaviour>
- <required behaviour>
- <required behaviour>

### Constraints and Important Conditions

Include only constraints that materially affect the solution.

Examples may include:

- compatibility requirements;
- existing architectural constraints;
- performance expectations;
- security or privacy requirements;
- required integrations;
- behaviour that must remain unchanged.

---

## 4. Expected Outcome

Describe what should be true once the change is complete.

Where useful, express this as a clear before/after comparison.

### Before

Describe the relevant current behaviour.

### After

Describe the expected behaviour after the change.

Be specific enough that the intended result is not open to interpretation.

---

## 5. Proposed Design

Describe the proposed solution at an architectural level.

Explain the main design decisions and how the relevant parts of the system will work together.

Cover:

- the overall approach;
- components or areas of the system that will change;
- new responsibilities or behaviours;
- interactions between components;
- important data or control flows;
- significant architectural decisions.

Do not describe individual source-file edits or produce a code-level implementation plan.

### High-Level Flow

Describe the end-to-end flow where that helps explain the design.

For example:

1. <event or user action>
2. <system response>
3. <backend processing>
4. <state or data change>
5. <result returned or displayed>

---

## 6. Backend Changes

Describe the expected backend changes.

Cover only areas relevant to the change, such as:

- services or application logic;
- APIs or commands;
- data access;
- domain behaviour;
- background processing;
- integrations;
- state management;
- persistence;
- error handling.

For each significant change, explain the intended responsibility and behaviour rather than the exact implementation.

If the change has no meaningful backend impact, state that briefly.

---

## 7. UI and User Experience Changes

Describe what changes from the user's perspective.

Cover, where relevant:

- screens, views, or components affected;
- new controls or interactions;
- changes to existing workflows;
- loading, empty, success, and error states;
- navigation or state transitions;
- information shown to the user;
- behaviour following user actions.

Describe the expected experience rather than pixel-level visual design.

If the change has no meaningful UI impact, state that briefly.

---

## 8. Data and State

Describe significant changes to data or state where applicable.

Include:

- new or changed data concepts;
- persistence changes;
- important state transitions;
- ownership of state;
- migrations or compatibility considerations;
- data exchanged between system components.

Do not include low-level schemas unless they are important to understanding the architecture.

---

## 9. Interfaces and Integrations

Describe any important interfaces introduced or changed.

This may include:

- internal APIs;
- external APIs;
- events;
- queues;
- commands;
- third-party integrations;
- boundaries between components.

Focus on responsibilities and expected interactions rather than implementation syntax.

Omit this section if no meaningful interface changes are involved.

---

## 10. Error and Edge-Case Behaviour

Describe important failure conditions or edge cases that materially affect the design.

For example:

- unavailable dependencies;
- invalid input;
- partial failures;
- conflicting state;
- retries;
- degraded behaviour;
- recovery expectations.

Avoid attempting to catalogue every possible programming error.

---

## 11. Validation Considerations

Describe the behaviours that will be important to prove when the change is implemented.

Identify significant areas that are likely to require:

- unit testing;
- integration testing;
- end-to-end testing;
- manual verification.

This is not the detailed test plan. Its purpose is to ensure that important design behaviour is not lost when implementation and validation are planned later.

---

## 12. Open Questions

List unresolved questions that materially affect implementation or behaviour.

- <question>
- <question>

If there are no meaningful open questions, state:

No outstanding design questions.

---

## 13. Design Summary

Summarise the key design decisions in a few concise points.

- <decision>
- <decision>
- <decision>

The summary should make clear what the implementation plan is expected to deliver.
