# Change Request: Workflow Transitions and Actions Panel

**Status:** Draft for review<br>
**Type:** High-level design (HLD)<br>
**Scope:** One board-scoped Workflow view, including transition and action configuration

## What problem does this solve?

Kangentic's current top-level UI exposes the board and backlog, and its Board Manager exposes settings that belong to individual columns. The workflow that connects those columns is a separate configuration layer. Users cannot currently inspect or edit that layer from the UI, even though it determines what happens when a task moves between columns.

This creates three practical problems:

1. A user cannot see all incoming and outgoing routes for a column.
2. A user cannot see the ordered actions attached to a route, including an agent-start prompt template.
3. A user must edit `kangentic.json` to make a workflow-level change, then re-import or wait for reconciliation. That path is also difficult to reason about when the persisted database and the file are temporarily out of sync.

The request is therefore to expose the existing workflow model in a board-scoped UI without creating a second workflow format or changing transition execution semantics.

## Proposed solution

Add a **Workflow** view at the same navigation level as **Board** and **Backlog**.

The view is column-oriented:

1. The left rail lists the board's columns and a separate actions entry.
2. Selecting a column shows all transitions in which that column participates, grouped as **Incoming** and **Outgoing**.
3. Selecting a transition shows its source, destination, and ordered action list.
4. Selecting an action opens an action editor with its name, type, and type-specific configuration.
5. The editor shows action reuse, so a user knows which other transitions will be affected by an action edit or delete.

The first version should use the existing actions and transitions IPC contracts and the existing DB-to-JSON write-back path. A later optimization may add one atomic workflow snapshot endpoint if separate reads prove too easy to observe in a mixed state.

The column editor remains responsible for column identity and column-local settings. The Workflow view owns routing and reusable action configuration. The two views should link to each other, but should not duplicate fields.

## Alternatives considered

### Continue editing JSON only

This preserves the current runtime but leaves the main workflow behavior invisible to users and makes simple routing changes dependent on hand-editing. It does not meet the request.

### Put transitions and actions inside Edit Columns

This makes a column appear to own configuration that is actually shared across multiple routes. It also makes action reuse and ordered execution difficult to understand. A board-scoped Workflow view gives the routing model an appropriate home.

### Build a graphical node editor first

A graph can be useful later, but a column list plus incoming/outgoing transition list is easier to implement, keyboard-navigate, test, and use on boards with many columns. A graph may be a future visualization over the same model rather than the source of truth.

### Add a new UI-only workflow model

This would duplicate persistence and risk divergence from `kangentic.json`, the action repository, and the transition engine. The UI should adapt the existing model instead.

## Additional context

The board currently has no configured workflow in the user's project. The empty state is therefore part of the design: the Workflow view must still list the columns, report that no transitions are configured, and offer a clear **Create transition** action. If actions exist without a transition, the view should show them as unused/orphaned rather than hiding them.

The import/hydration symptom where a configured column `autoCommand` (the UI's **Message to agent**) appears blank is a separate workstream. It should be fixed and regression-tested alongside or before this feature, but it must not be silently “fixed” by changing the transition UI. A workflow editor must clearly distinguish a column's `autoCommand` from an action's `config.promptTemplate`.

## High-level design

### 1. Existing model and verified current behavior

The following describes the current repository as inspected for this HLD.

#### Columns

`BoardColumnConfig` in `src/shared/types.ts` is the JSON representation of a column. It contains identity and presentation fields plus column-local automation such as `autoSpawn`, `autoCommand`, permission mode, agent/model/effort overrides, and session strategy. `Swimlane` rows in the project database are the runtime representation.

The current Board Manager (`src/renderer/components/dialogs/BoardManagerDialog.tsx`) edits these column settings. It does not edit transitions or actions.

#### Actions

`BoardActionConfig` is the JSON representation:

```ts
interface BoardActionConfig {
  id?: string;
  name: string;
  type: ActionType;
  config: ActionConfig;
}
```

The database `Action` row stores the same configuration as `config_json`. The current declared action types are `create_worktree`, `spawn_agent`, `send_command`, `create_pr`, `run_script`, `cleanup_worktree`, `kill_session`, and `webhook`.

`ActionConfig.promptTemplate` belongs to a `spawn_agent` action. It is not a column description, `autoCommand`, or transition field. Other action configuration is type-specific, for example a command for `send_command`, a script and working directory for `run_script`, and URL/method/body/headers for `webhook`.

#### Transitions

`BoardTransitionConfig` is serialized by column and action **names**:

```ts
interface BoardTransitionConfig {
  from: string;      // column name or '*'
  to: string;        // column name
  actions: string[]; // action names, in execution order
}
```

The database stores one row in `swimlane_transitions` per action occurrence, with `from_swimlane_id`, `to_swimlane_id`, `action_id`, and `execution_order`. The source may be the wildcard `'*'`; the destination is a concrete column. Therefore the relationship is not one-to-one:

- one column can have many incoming and outgoing transitions;
- one transition has an ordered list of zero or more action rows;
- one action can be reused by many transitions;
- the same action may occur more than once in a sequence under the current low-level `setTransitions` contract, so the UI must not silently deduplicate unless that behavior is explicitly changed and tested.

`ActionRepository.getTransitionsFor` gives an exact source/destination pair priority and falls back to a wildcard-source pair. `TransitionEngine.executeTransition` loads the resolved rows and executes them in `execution_order`.

#### Persistence and synchronization

The current flow is:

```text
kangentic.json (+ local overrides)
        -> BoardConfigManager / applyBoardConfigToDb
        -> project SQLite database
        -> existing IPC repositories
        -> renderer

renderer mutation
        -> existing IPC handler
        -> database mutation
        -> BoardConfigManager write-back
        -> kangentic.json
```

`apply-config.ts` reconciles actions and transition pairs from JSON by name after resolving IDs. `build-config.ts` reads the database and writes actions and transitions back using names, while retaining stable IDs for reconciliation. The existing IPC handlers in `src/main/ipc/handlers/board.ts` already list/create/update/delete actions and list/set transitions; each mutation triggers write-back.

This HLD treats that flow as canonical. It does not propose a new JSON schema or a second persistence store.

### 2. Proposed user experience

#### Navigation

Extend the existing segmented view control in `ViewToggle.tsx` with **Workflow**. The active view type becomes `board | backlog | workflow`. `AppLayout.tsx` renders `WorkflowView` for that state and keeps the board terminal panel and backlog dialogs scoped to their existing views.

The workflow view is board/project scoped. Switching projects reloads columns, actions, and transitions for the newly active project and resets or reconciles selection by ID.

#### Layout

The proposed layout has three regions:

```text
┌──────────────────┬──────────────────────────────┬─────────────────────────────┐
│ Columns           │ Transitions for selected     │ Selected transition/action  │
│                  │ column                       │                             │
│ Planning         │ Incoming                     │ From: Worktree              │
│ Worktree         │   Worktree -> Planning       │ To: Planning                │
│ Code Review      │   To Do -> Planning          │                             │
│                  │ Outgoing                     │ Actions (ordered):          │
│ Actions          │   Planning -> Worktree       │  1. Kill session             │
│                  │                              │  2. Start planning agent    │
│                  │                              │                             │
│                  │                              │ [Edit action] [Save]        │
└──────────────────┴──────────────────────────────┴─────────────────────────────┘
```

The exact visual treatment is implementation detail; the information hierarchy is the requirement.

#### Column selection

Selecting a column shows:

- its incoming transitions, including wildcard-source transitions that apply to it;
- its outgoing transitions;
- whether each route has no actions, one action, or an ordered action count;
- warning badges for missing columns/actions or stale data.

The column itself links back to Edit Columns for description, icon, color, auto-spawn, **Message to agent**, permissions, and session settings.

#### Transition editing

The transition editor supports:

- a concrete source column or wildcard `*`;
- a concrete destination column;
- an ordered action sequence;
- add/remove/reorder actions;
- explicit delete with confirmation;
- validation before save.

Because the current persistence operation is a replace of one `(from, to)` pair, the UI should save the whole ordered sequence for the selected pair in one call. It must not issue one write per drag step.

#### Action catalog and editing

The Actions area lists all actions with type, usage count, and affected transitions. It supports create, edit, and delete. Before deletion, show every transition that references the action. The existing repository currently deletes transition rows when an action is deleted; the UI should make that cascade explicit and require confirmation.

The action form renders only fields appropriate to the selected type:

| Action type | Configuration exposed by the proposed form |
| --- | --- |
| `spawn_agent` | Agent override, prompt template, non-interactive flag |
| `send_command` | Command template |
| `run_script` | Script, working directory |
| `create_worktree` | Base branch, files to copy |
| `cleanup_worktree` | No current config fields; show explanatory text |
| `kill_session` | No current config fields; show explanatory text |
| `webhook` | URL, HTTP method, body, headers |
| `create_pr` | Show as unavailable until runtime support is confirmed; see Open decisions |

The prompt editor should show available task template variables as help, not silently rewrite the template. It must preserve multiline text and JSON escaping through the existing `config_json` boundary.

### 3. Renderer architecture

#### Workflow view and store

Add `src/renderer/components/workflow/WorkflowView.tsx` and a focused workflow store, likely `src/renderer/stores/workflow-store.ts` or a `workflow-store/` slice directory matching existing store conventions.

The store should own:

- the loaded column/action/transition snapshot;
- selected column, transition pair, and action;
- loading/error/stale state;
- dirty draft for one transition or action at a time;
- save/cancel/reload operations;
- project identity used to reject late responses from a previous project.

The store should derive view models rather than mutate shared board swimlane state. The existing board store remains the owner of board tasks and column editing state.

#### Stable identity and name mapping

Use database IDs for renderer selection and IPC mutation. Resolve names only at the JSON boundary. Do not use the display name as React identity or selection identity: JSON transitions use names for compatibility, while the database and action references use UUIDs.

The renderer should retain a display-name snapshot on each selected transition so a column/action rename can be detected. A rename must either update the draft references in one save flow or force a reload before editing a dependent transition.

#### Staleness

The first implementation may load `swimlanes.list`, `actions.list`, and `transitions.list` through the existing APIs, then normalize them in the store. If the three-call snapshot can be observed in inconsistent states, add a project-scoped `workflow:getSnapshot` IPC call that reads the three repositories in one main-process turn. This is an optimization and consistency improvement, not a new persistence model.

### 4. Main-process and IPC architecture

#### Existing contracts to reuse

The preload already exposes:

- `window.electronAPI.swimlanes.list()`;
- `window.electronAPI.actions.list/create/update/delete()`;
- `window.electronAPI.transitions.list/set/getForTransition()`.

The existing board IPC handler obtains project repositories and calls `triggerWriteBack` after every action or transition mutation. The Workflow view should use those contracts initially.

#### Proposed contract hardening

The following changes are proposed only where needed by implementation:

- validate that a transition's destination exists and its source is either `*` or an existing column;
- validate that every action ID in a transition exists;
- validate action type/config shape before storing `config_json`;
- reject duplicate action names because JSON transition resolution is name-based;
- return a structured warning/error that the renderer can show without losing the current draft;
- optionally add a batch snapshot endpoint and project ID parameter if current ambient-project calls cannot provide sufficient staleness protection.

The existing low-level `setTransitions(fromId, toId, actionIds)` behavior should remain the single replacement operation for a pair. If validation fails, leave the existing pair untouched.

#### Repository changes

`src/main/db/repositories/action-repository.ts` should remain responsible for action and transition persistence. It may gain read helpers for action usage and a validation-aware replacement method. Its delete cascade behavior must be documented in the UI and covered by tests. The repository should preserve execution order exactly as supplied by the UI.

No transition-engine rewrite is proposed. `src/main/transition-engine/transition-engine.ts` should continue to resolve exact transitions before wildcard transitions and execute action rows in order. The Workflow feature must not alter `spawn-intent.ts`, prompt interpolation, session lifecycle, or action side effects.

### 5. JSON/config integration

The existing canonical shape remains:

```json
{
  "version": 1,
  "columns": [],
  "actions": [
    { "id": "...", "name": "Start planning agent", "type": "spawn_agent", "config": { "promptTemplate": "..." } }
  ],
  "transitions": [
    { "from": "Worktree", "to": "Planning", "actions": ["Kill session", "Start planning agent"] }
  ]
}
```

The example is illustrative; the implementation must preserve the project's actual IDs, names, templates, and ordering.

Save behavior:

1. Action save calls the existing action update/create IPC handler.
2. Transition save sends the complete ordered action ID list for its pair.
3. The main process updates SQLite and triggers board config write-back.
4. `build-config.ts` serializes the action and transition rows into the existing name-based JSON shape.
5. The store refreshes from the authoritative DB response or a fresh snapshot and clears the draft only after success.

Import behavior:

1. `BoardConfigManager` reads and validates team/local config.
2. `applyBoardConfigToDb` reconciles columns, actions, and named transitions.
3. The Workflow store receives a board/config changed signal or reloads on project activation.

The separate `autoCommand` hydration defect should be investigated in `apply-config.ts`, `build-config.ts`, board hydration, and Board Manager binding tests. The Workflow view must not map `autoCommand` to `spawn_agent.config.promptTemplate` or vice versa.

## Impacted files and proposed changes

The list below distinguishes verified current responsibility from proposed changes.

| File or area | Current responsibility (verified) | Proposed change |
| --- | --- | --- |
| `src/renderer/components/board/ViewToggle.tsx` | Renders Board/Backlog segmented navigation and view-specific controls. | Add Workflow option and workflow-specific toolbar affordances without leaking board search/filter controls into the workflow view. |
| `src/renderer/stores/board-store/active-view-slice.ts` | Stores `board | backlog` and changes the active view. | Extend the union to include `workflow`; preserve existing default and keyboard behavior. Add tests for switching and project reset if required. |
| `src/renderer/components/layout/AppLayout.tsx` | Chooses `KanbanBoard` or `BacklogView`, and owns board terminal/backlog dialog mounting. | Mount `WorkflowView` for the new state; keep terminal panel and backlog dialogs scoped correctly. Reset view-specific transient UI on project change. |
| `src/renderer/components/workflow/WorkflowView.tsx` (new) | No current file. | Implement the board-scoped three-region view, empty state, selection, stale/error state, and links to column settings. |
| `src/renderer/components/workflow/WorkflowColumnRail.tsx` and related components (new, optional split) | No current files. | Render columns, action catalog, usage counts, and selection affordances. Keep action reuse visible. |
| `src/renderer/components/workflow/TransitionList.tsx` / `TransitionEditor.tsx` (new, optional split) | No current files. | Render incoming/outgoing routes and edit the complete ordered action list for a pair, including wildcard source support. |
| `src/renderer/components/workflow/ActionEditor.tsx` (new, optional split) | No current file. | Render type-specific `ActionConfig` fields, prompt template help, JSON-safe multiline editing, and reuse/deletion warnings. |
| `src/renderer/stores/workflow-store.ts` (new) | No current workflow store. | Own normalized snapshot, project-scoped selections, drafts, saves, reloads, and stale response guards. |
| `src/shared/types.ts` | Defines `Action`, `ActionConfig`, `SwimlaneTransition`, `BoardActionConfig`, `BoardTransitionConfig`, `BoardConfig`, and `ElectronAPI`. | Add only view/IPC result types that are genuinely needed. Keep the canonical JSON types and action/transition semantics unchanged. Consider a structured validation result rather than string-only errors. |
| `src/shared/ipc-channels.ts` | Declares action/transition IPC channels. | Reuse current channels; add a workflow snapshot channel only if the implementation chooses the atomic-read option. |
| `src/preload/preload.ts` | Exposes action and transition list/mutation methods to the renderer. | Reuse current methods; wire any new snapshot or structured validation contract without exposing raw Electron APIs. |
| `src/main/ipc/handlers/board.ts` | Registers action and transition handlers, resolves project repositories, and triggers write-back. | Add validation and/or a snapshot handler as needed. Preserve write-back after successful mutation and avoid partial transition replacement on invalid input. |
| `src/main/ipc/helpers/project-repos.ts` | Creates project-scoped repositories from the current/explicit project ID. | Reuse for workflow reads/writes; ensure late project responses cannot be applied to the wrong renderer project. |
| `src/main/db/repositories/action-repository.ts` | Persists actions, transition rows, ordering, wildcard fallback, and delete cascade. | Add usage/snapshot helpers and transaction-level validation only if required. Preserve action reuse and order. |
| `src/main/config/board-config/apply-config.ts` | Applies JSON columns/actions/transitions to SQLite, resolving transitions by names and warning on unknown references. | Add regression coverage and only the validation/diagnostics needed for UI round-trip. Keep the existing canonical reconciliation policy. |
| `src/main/config/board-config/build-config.ts` | Builds JSON from DB, serializing actions and grouped name-based transitions. | Preserve current shape/order; add parity tests for action prompt templates, wildcard transitions, reused actions, and empty workflows. |
| `src/main/config/board-config/config-helpers.ts` | Validates config shape and merges team/local columns, actions, and transitions. | Extend validation for references or duplicate names if agreed; surface actionable errors to the Workflow UI. |
| `src/main/config/board-config-manager.ts` | Loads/applies config, watches files, and writes DB changes back to JSON. | Ensure Workflow reloads after apply/file-change events; do not introduce a parallel persistence route. |
| `src/renderer/components/dialogs/BoardManagerDialog.tsx` | Edits column settings and profiles. | Keep it column-focused; optionally add an “Open Workflow” link. Fix the independent `autoCommand` blank-field mapping in its own change/test scope. |
| `src/main/transition-engine/transition-engine.ts` | Resolves and executes transitions/actions, including spawn prompt interpolation. | No behavior change expected. Add integration assertions that UI-edited ordered actions execute unchanged. Review declared `create_pr` support before exposing it for authoring. |
| `src/main/transition-engine/spawn-intent.ts` | Resolves fresh/resume spawn intent and prompt input. | No change; preserve `spawn_agent.config.promptTemplate` semantics. |
| `tests/unit/board-config*.test.ts` | Covers board config validation, application, cache/watch/write-back, and parity. | Add round-trip tests for actions/transitions, wildcard source, reused actions, order, unknown references, and empty workflow. |
| `tests/unit/action-repository.test.ts` (new or existing repository suite) | No verified dedicated workflow UI contract. | Test usage queries, replacement atomicity, delete cascade, duplicate/unknown reference validation, and order preservation. |
| `tests/unit/workflow-store.test.ts` / component tests (new) | No current workflow UI tests. | Test selection, incoming/outgoing grouping, wildcard display, action reuse warnings, project switch/stale response handling, and empty state. |
| `tests/ui/workflow.spec.ts` (new) | No current Workflow view coverage. | Exercise navigation, create/edit/reorder/delete flow, JSON write-back, and import reload at the UI boundary. |

The implementation should stage only files required by the approved phase. The table is an impact map, not authorization to change every listed file in one patch.

## Contracts and invariants

The following must remain true after implementation:

1. `kangentic.json` remains the canonical shared format; no UI-only workflow file is introduced.
2. Database IDs are used for runtime references and renderer selection; JSON names are used only at the serialization/import boundary.
3. Action names remain unique because transitions resolve action names during JSON import.
4. A transition has one source/destination pair and an ordered action sequence. Saving replaces that pair atomically.
5. `*` is valid only as a transition source; a transition destination is a concrete column.
6. Exact source/destination transitions retain priority over wildcard-source transitions.
7. Action reuse is preserved. Editing an action updates every transition that references it; deletion warns about and explicitly confirms the existing cascade.
8. Action execution order is preserved from UI ordering to SQLite `execution_order` to runtime execution and JSON write-back.
9. Unknown columns/actions do not produce silently broken routes. They are rejected or shown as actionable warnings according to the existing config policy.
10. A failed save leaves the persisted route/action and the local draft recoverable; it must not clear the form.
11. `autoCommand` remains a column-local command. `spawn_agent.config.promptTemplate` remains an action prompt.
12. A project switch or config import cannot apply a stale response to the currently selected project.

## Validation and error behavior

Client-side validation should catch missing source/destination, empty action names, duplicate action names, invalid type-specific required fields, malformed structured configuration, and references to deleted entities before issuing a mutation.

Main-process validation remains authoritative. The handler/repository should validate again because renderer validation is advisory. Errors should identify the affected transition/action in human terms and return a structured result where possible.

Stale data behavior:

- If a file import or agent mutation changes the workflow while a draft is open, mark the view stale and offer **Reload** or **Keep editing**.
- If a selected column/action was deleted, clear only the invalid selection and preserve the rest of the snapshot.
- If an action is renamed elsewhere, show the new name and re-evaluate usage before saving.
- If a write-back fails after the DB mutation, report the persistence failure and offer retry/export diagnostics; do not claim the JSON is updated.

## Testing and acceptance criteria

### Acceptance criteria

- A user can navigate to Workflow beside Board and Backlog for the active project.
- The view lists all columns even when there are no transitions.
- Selecting a column shows all incoming and outgoing transitions, including wildcard-source routes.
- Selecting a transition shows source, destination, and ordered actions.
- A user can create, edit, reorder, and delete a transition while preserving action order.
- A user can create and edit supported actions, including a multiline `spawn_agent` prompt template.
- The UI shows action reuse and warns about the existing delete cascade.
- A saved action/transition is visible after reload and round-trips through the existing `kangentic.json` shape.
- Importing a config with action and transition IDs/names hydrates the same workflow the UI displays.
- Invalid references and unsupported action types are visible and actionable; they do not silently execute a different workflow.
- Existing Board, Backlog, terminal, column editor, and transition-engine behavior remains unchanged.
- The independent `autoCommand`/Message-to-agent defect has a separate regression test and does not get conflated with action prompt rendering.

### Suggested test layers

1. Pure view-model tests for grouping and wildcard semantics.
2. Store tests for save, reload, project identity, stale response, and failed-save behavior.
3. Repository/IPC tests for atomic replacement, validation, reuse, and cascade warnings.
4. Config parity tests for JSON -> DB -> JSON with action templates and ordered transitions.
5. UI tests for navigation and the main create/edit/reorder/delete paths.

## Delivery phases

### Phase 0: Contract and defect baseline

- Add fixtures for empty workflow, wildcard source, reused action, action prompt, and malformed references.
- Reproduce and isolate the separate column `autoCommand` hydration issue.
- Confirm runtime support for every declared `ActionType`, especially `create_pr`.

### Phase 1: Read-only Workflow view

- Add navigation, store load, column rail, incoming/outgoing transition list, action catalog, and empty/stale states.
- Reuse current list IPC endpoints.
- Add rendering and grouping tests.

### Phase 2: Transition and action editing

- Add validated transition pair replacement and ordered action editing.
- Add type-specific action forms and action reuse/delete confirmation.
- Add write-back and round-trip tests.

### Phase 3: Hardening and import UX

- Add atomic snapshot IPC only if needed by observed staleness.
- Finish import/hydration fix for column commands as a separate change.
- Add UI-level regression coverage and usability polish.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Actions are reusable, so a local edit has multiple downstream effects. | Show usage before edit/delete; display affected transitions after save. |
| JSON uses names while DB/runtime uses IDs. | Keep IDs in UI state; validate unique names; test rename and round-trip behavior. |
| Wildcard source semantics are easy to hide. | Display wildcard as “Any source” with an explicit indicator and test exact-over-wildcard precedence. |
| Existing set operation replaces a pair. | Save a complete ordered sequence atomically; avoid one mutation per drag gesture. |
| Delete currently cascades transition rows. | Show affected routes and require confirmation; add repository tests. |
| Some declared action types may not have runtime execution support. | Confirm support in Phase 0; do not expose unsupported authoring paths as executable. |
| Separate IPC reads can observe a mixed snapshot. | Track project identity and stale state; add a main-process snapshot endpoint if needed. |
| File import can leave UI fields blank or stale. | Separate the `autoCommand` fix, reload on config events, and add parity tests. |
| Prompt templates contain user-authored text and multiline content. | Use a plain text editor, preserve exact content, and serialize only at the existing JSON boundary. |

## Open decisions for approval

1. Should the first implementation use the existing three list calls or require an atomic `workflow:getSnapshot` endpoint from the beginning?
2. Should action sequences allow the same action ID more than once, matching the current low-level contract, or should the product impose a no-duplicates rule with an explicit migration/validation policy?
3. Is `create_pr` intended to be enabled in the action editor now, or should it remain read-only/unavailable until `TransitionEngine.executeAction` support exists?
4. Should the Workflow view include a direct “Edit JSON” escape hatch for unsupported fields, or should it only surface unsupported configuration with a link to the existing config workflow?
5. Should a user be allowed to edit a shared action inline from a transition, or must the action catalog be the only edit entry point to emphasize reuse?

## Template check

This document intentionally expands the standard change-request sections into an HLD because the requested review requires architecture, interfaces, invariants, file impact, testing, and delivery detail.

- [x] I read the requested change and documented the current problem, proposed solution, alternatives, context, and implementation design.
