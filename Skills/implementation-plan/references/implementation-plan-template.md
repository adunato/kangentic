# Implementation Plan: <change name>

## 1. Implementation Summary

Briefly describe how the approved HLD will be implemented.

Focus on the practical shape of the work rather than repeating the full design.

Include:

- the main implementation approach;
- the primary areas of the system affected;
- any important sequencing or dependency.

Keep this section concise.

---

## 2. HLD Reference

Summarise only the key design decisions from the HLD that directly constrain implementation.

Do not reproduce the HLD.

- <design decision>
- <design decision>
- <design decision>

---

## 3. Repository Assessment

Summarise what repository inspection revealed about the existing implementation.

Include only information relevant to planning the change.

For example:

- existing components or modules involved;
- reusable behaviour already present;
- important architectural patterns that should be followed;
- implementation constraints discovered in the codebase;
- areas where existing behaviour will need to be replaced or extended.

If nothing materially changes the implementation approach, say so briefly.

---

## 4. Implementation Approach

Describe how the change will be implemented from end to end.

Break the work into logical implementation areas rather than arbitrary project-management tasks.

### 4.1 <Implementation Area>

Describe:

- what will change;
- why it needs to change;
- how it fits into the overall implementation;
- dependencies on other parts of the change.

### 4.2 <Implementation Area>

Describe the next significant part of the implementation.

Add or remove subsections as needed.

---

## 5. Implementation Sequence

Describe the preferred order of work where sequencing matters.

For example:

1. <establish or modify underlying capability>
2. <implement dependent behaviour>
3. <integrate consumers or UI>
4. <complete supporting behaviour>
5. <run integrity checks and prepare for validation>

Explain dependencies where the reason for the order is not obvious.

Do not invent sequencing merely to populate this section. If the work can be completed independently, say so.

---

## 6. Development Integrity Checks

Identify checks that should be completed as part of development before the separate validation stage.

Examples include:

- linting;
- formatting;
- type checking;
- compilation;
- build verification;
- static analysis;
- project-specific integrity checks.

List only checks relevant to the repository.

---

## 7. Validation Requirements

Describe what the later validation stage must prove.

Identify important:

### Unit Validation

- <behaviour that should be covered>
- <behaviour that should be covered>

### End-to-End Validation

- <user flow or system behaviour that should be proven>
- <user flow or system behaviour that should be proven>

### Other Relevant Validation

Include integration, migration, compatibility, or manual checks only where needed.

This section defines validation expectations, not detailed test implementation.

---

## 8. Open Implementation Questions

List unresolved questions that need to be answered before or during detailed design or development.

- <question>
- <question>

If none remain, state:

No outstanding implementation questions.

---

## 9. Low-Level Design Decision

**LLD required:** <Yes / No>

### Rationale

Explain why a separate Low-Level Design is or is not justified.

Consider:

- implementation complexity;
- number and coupling of affected components;
- amount of repository-specific design still required;
- unresolved technical choices;
- risk of designing important details while coding.

If an LLD is required, briefly identify what it needs to resolve.

If an LLD is not required, confirm that the implementation plan and HLD provide sufficient direction to proceed directly to development.

---

## 10. Implementation Checklist

Summarise the planned work as a concise checklist.

- [ ] <implementation activity>
- [ ] <implementation activity>
- [ ] <implementation activity>
- [ ] Complete relevant development integrity checks
- [ ] Complete implementation summary for hand-off to validation

The checklist should reflect the actual plan above rather than introduce new requirements.
