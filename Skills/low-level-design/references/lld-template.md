# Low-Level Design: <change name>

## 1. Change Overview

Briefly state the implementation shape of the change.

Keep this to a few sentences.

Do not repeat the requirements or architectural design from the HLD.

---

## 2. File Changes

### `<path/to/file>`

**Action:** Modify | Create | Remove | Move

Describe the change required in this file.

Be specific about the relevant responsibility, component, function, class, type, handler, or other structure where useful.

Explain how the file should behave after the change.

Include interactions with other affected files only where they help clarify the implementation.

Example code may be included when useful:

```text
<illustrative snippet, signature, structure, or pseudocode>
```

Do not provide a diff or line-by-line patch.

---

### `<path/to/another-file>`

**Action:** Modify | Create | Remove | Move

Describe the required change.

---

### `<path/to/new-file>`

**Action:** Create

Describe:

- why the file exists;
- its responsibility;
- its important interfaces or exported behaviour;
- how it participates in the overall implementation.

---

Add one section for every significant file affected by the change.

---

## 3. Cross-File Dependencies

Include this section only when sequencing or interaction between file changes is not obvious.

Describe important dependencies such as:

1. `<file or component>` establishes <capability/interface>.
2. `<dependent file>` consumes or extends it.
3. `<another file>` integrates the resulting behaviour.

Keep this focused on implementation dependencies rather than repeating the architecture.

If there are no meaningful dependencies to call out, omit this section.

---

## 4. File Change Summary

| File | Action | Purpose |
| --- | --- | --- |
| `<path>` | Modify | <short description> |
| `<path>` | Create | <short description> |
| `<path>` | Remove | <short description> |

This table should provide a quick inventory of the expected implementation surface and must agree with the detailed file entries above.
