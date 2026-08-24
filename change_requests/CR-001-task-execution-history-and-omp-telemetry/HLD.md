# High-Level Design: Task Execution History and OMP Telemetry

## 1. Summary

Kangentic currently records the lifecycle and a lifetime aggregate for each task execution, but it cannot reliably explain which workflow stage an execution belonged to or which portion of a resumed OMP conversation it owns. It also lacks normalized provider/model usage and an independent account of telemetry quality and diagnostics.

This change adds a per-project execution-history ledger attached to the existing `sessions` execution entity. It preserves current session aggregates and lifecycle behavior while capturing immutable stage/provenance snapshots, durable non-overlapping OMP execution slices, detailed usage and signals, and a structured history read model. Native OMP transcript data is fetched only when the user explicitly opens the relevant execution detail.

## 2. Current State

### Observed facts

- Each project has an isolated SQLite database. `sessions` is the existing execution record and stores task association, lifecycle status, native agent identifiers, timestamps, exit information, and aggregate cost/token/model/tool metrics.
- A task points to its current workflow stage (swimlane). Session startup can create a new native execution or resume an existing one, so multiple Kangentic session rows can share one OMP native session.
- Stage configuration and effective agent/profile settings are available at startup, but no immutable stage or configuration snapshot is retained on the session. Existing history therefore cannot safely reconstruct the stage after a task moves.
- OMP history is read from native files through adapter parsers and cursors. Existing usage and transcript indexing supports deduplication, but ownership can be reassigned during resumed replay and does not provide immutable Kangentic execution ranges.
- Existing persistence includes aggregate session metrics, usage snapshots, conversation turn usage, PTY transcript storage, and whole-task transcript viewing. The current transcript view intentionally stitches all sessions for a task into one lifecycle conversation.
- Existing lifecycle statuses describe process state (`running`, `queued`, `suspended`, `exited`, and `orphaned`), not a complete execution-result taxonomy. Telemetry collection failures are best effort and must not stop lifecycle transitions.
- The task detail experience has terminal, browser, changes, and description areas plus an archived-session summary. It has no structured execution-history surface or slice-specific transcript view.

These are starting-state observations, not decisions about the new result taxonomy, OMP identity guarantees, or product presentation.

## 3. Requirements

### Functional Requirements

- Keep `sessions` as the canonical Kangentic execution entity; do not introduce a parallel generic execution table.
- At execution start, snapshot the workflow stage column ID and name, relevant stage configuration version/hash, effective agent/profile/config provenance, and a stage attempt number. The snapshot must remain unchanged if the task later moves.
- For OMP-backed sessions, retain native session lineage and durable start/end event boundaries or cursors so resumed Kangentic rows own deterministic, non-overlapping native ranges.
- Normalize usage by provider and model, including input, output, cache-read, cache-write, nullable cost, and assistant-message/observation timing. Preserve current aggregate session metrics as compatibility projections and for fast display.
- Record relevant execution signals, including tool calls and errors, model changes, compactions, assistant turns, and collection status/version, independently of the execution result.
- Finalize collection on success, failure, suspension, interruption, cancellation, and crash/recovery paths. Collection, parsing, or persistence failures must not block agent execution or workflow movement, and repeated finalization must be idempotent.
- Provide a structured chronological execution-history read model with summary, stage/status filtering, execution details, model breakdown, signals, and provenance.
- Load native OMP JSONL lazily only after a user requests transcript details, and show exactly the selected Kangentic execution slice rather than the entire resumed native conversation.
- Preserve legacy records and semantics. Existing records must display an unknown stage rather than inferring stage from the task's current column, and unavailable telemetry must remain unknown/null rather than being represented as zero.
- Avoid capturing full transcripts, environment data, API secrets, or other unapproved sensitive context. Controlled history/transcript interfaces may support a future review agent, but review automation is outside this change.

### Constraints and Important Conditions

- The design is additive and scoped to each project database; all history queries and lifecycle updates must retain explicit project isolation.
- Existing aggregate columns and current lifecycle/session APIs remain compatible while new detail data is collected.
- Native OMP files may be missing, malformed, truncated, replaced, or pruned. Timestamps alone must not be assumed to define ownership boundaries.
- Execution result and telemetry collection state are separate concerns. A successful execution may have unavailable telemetry, and telemetry diagnostics must not overwrite the execution result.
- Provider identity, authoritative cost semantics, stable native event identity, exact attempt semantics, provenance allowlisting, and list pagination policy are not assumed by this design; they are open questions below.

## 4. Expected Outcome

### Before

Kangentic can show a lifetime session summary and a task-level conversation, but resumed native sessions can blur ownership between execution rows. Historical stage information is lost when a task moves, usage is not consistently normalized by provider/model, and collection diagnostics are mixed with best-effort metric updates. A user cannot inspect a structured, stage-aware execution history or a transcript for only one execution slice.

### After

Every newly started session has an immutable stage and effective-provenance snapshot and an assigned attempt value. OMP-backed sessions have durable, non-overlapping native boundaries, allowing usage and signals to be attributed to the owning Kangentic row even after resume. History displays normalized per-provider/model detail alongside preserved aggregates, clearly distinguishes execution result from telemetry health, and handles partial or legacy data as unknown. Users can inspect a chronological structured history first and explicitly load the exact native transcript slice for a selected execution.

## 5. Proposed Design

The system will extend the existing per-project `sessions` model with an additive execution-history ledger. `sessions` remains the canonical execution entity and continues to own lifecycle state and compatibility aggregates. New child detail records and read-model data describe stage provenance, native range ownership, normalized usage, signals, and telemetry diagnostics without replacing existing session records.

The OMP adapter will expose enough native lineage and boundary information for a durable ownership component to reserve a non-overlapping range for each Kangentic row. The exact native identity mechanism is intentionally not selected here; the ownership contract must remain stable across resume and must detect or report file replacement/truncation rather than silently overlapping ranges.

A database-backed history read model will assemble session identity, immutable snapshots, result state, aggregate projections, normalized usage, signals, and telemetry status. The initial history request reads this model only. Native JSONL parsing occurs only for an explicit transcript request and is constrained by the persisted slice boundary.

Execution result is a domain outcome derived by a future explicit policy from lifecycle evidence. Telemetry status describes whether collection and parsing succeeded, partially succeeded, or is unavailable. Neither status is used as a substitute for the other.

### High-Level Flow

1. A task is about to start or resume an execution. Before task movement can alter its current stage, the system captures the stage snapshot, effective allowed provenance, and attempt value on the new `sessions` record.
2. For an OMP execution, the adapter records native lineage and establishes a durable slice ownership boundary. A resumed native session receives a new non-overlapping range rather than reusing the whole native conversation.
3. During execution, parser/collector updates normalized usage and signals for the owned range. Aggregate session metrics continue to be maintained as compatibility projections; unknown values remain unknown.
4. On every supported terminal or recovery path, a non-blocking finalizer closes the range, writes the execution/telemetry state and diagnostics, and reconciles aggregates. An idempotency key prevents duplicate finalization from changing results.
5. The history read model exposes a chronological list and selected execution details from the database without opening native JSONL.
6. When the user requests a transcript, the system resolves the selected row's persisted native slice, parses only that range, and renders it in the existing conversation-style viewer. Missing or unusable native data produces an unavailable state without changing recorded execution outcome.

## 6. Backend Changes

### Session startup and provenance

Both normal transition-engine startup and automatic spawn/resume startup must capture the immutable stage ID/name, stage configuration version/hash, effective agent/profile/config provenance, and attempt value at the point the session row is created. Later task moves must not update these historical values.

### Durable native slice ownership

Introduce an explicit ownership concept for native OMP event ranges. It associates a Kangentic session row with its native session lineage and durable start/end boundary or cursor, with enough source identity to detect replacement or truncation. Allocation and finalization must make ownership deterministic and non-overlapping across resumed rows. Existing conversation usage deduplication may remain useful for compatibility, but it is not the authority for immutable Kangentic slice ownership.

### Usage and signal collection

Extend OMP collection to normalize provider/model usage and timing into durable detail records, retaining nullable cost and the separate cache buckets. Collect tool outcomes, model changes, compactions, assistant turns, and other supported diagnostics with the selected telemetry version. Parent and nested activity must follow an explicit attribution policy rather than being silently double-counted.

Maintain current aggregate session fields as projections for existing summaries and consumers. A missing provider, cost, token bucket, or signal is represented as unknown/null; it is not converted to a known zero.

### Finalization and resilience

Use one idempotent finalization path callable from success, failure, suspend, interrupt, cancellation, crash reconciliation, and restart recovery. It should persist all information available so far, record collection diagnostics independently, and permit later retry. Parser, native-file, or database errors are isolated from PTY execution and workflow movement; finalization may be incomplete without changing the process outcome already observed.

### Read model and access

Add a project-scoped structured history query that returns chronological executions, summary/result, immutable provenance, stage/status filters, usage breakdown, signals, and telemetry state. Keep the existing whole-task transcript behavior separate from the new slice-specific transcript operation. A future controlled API may expose the same read model to review tooling, but implementing review automation is out of scope.

## 7. UI and User Experience Changes

Add a task-detail History surface distinct from the existing terminal, browser, changes, and description areas. It presents executions chronologically and supports the history read model's summary, stage/status filtering, execution details, model/provider breakdown, signals, and immutable provenance. It should represent active, completed, failed, suspended, legacy, partial, and unavailable telemetry without implying that missing data is zero.

Selecting an execution opens a details view with its result and telemetry status shown separately. A transcript action is explicit and lazy: the initial history view must not parse native OMP JSONL, while the action loads and renders only the selected slice using the existing conversation rendering patterns. If the native source is unavailable or its boundary is invalid, the details view explains that transcript data is unavailable while retaining structured metadata.

The surface must have clear loading, empty-history, partial-data, failed-execution, and unavailable-transcript states. It must remain usable for long histories, narrow/mobile layouts, and executions involving multiple models. The exact active-task visibility, list-size/pagination behavior, and whether to share or specialize the current conversation viewer remain product questions.

## 8. Data and State

- **Canonical execution:** `sessions` continues to represent one Kangentic execution row and retains lifecycle state, timestamps, native lineage, and compatibility aggregate metrics.
- **Immutable provenance:** each new session stores its stage ID/name, configuration version/hash, effective agent/profile/config context, and attempt value captured at start. Legacy rows contain an explicit unknown stage/provenance state rather than a value inferred from current task state.
- **Native slice ownership:** each OMP-backed row stores native session lineage and durable start/end ownership boundaries or cursors, plus collection status needed to determine whether the slice is complete and trustworthy.
- **Normalized usage:** child detail data stores provider/model dimensions, input/output/cache-read/cache-write quantities, nullable cost, and assistant-message/observation timing. Aggregates on `sessions` remain compatibility projections and may be updated as information becomes available.
- **Signals and diagnostics:** tool calls/errors, model changes, compactions, assistant turns, telemetry collector version, collection state, and diagnostic details are separate from execution result.
- **State transitions:** execution lifecycle follows existing process behavior; finalization closes the execution and records the best available telemetry. Collection may transition independently through available, partial, failed, or unavailable states. Repeated finalization is a no-op or reconciliation of the same ownership key.
- **Compatibility and privacy:** existing records remain readable with unknown stage/result detail where no historical data exists. New context is limited to an approved provenance allowlist; no full transcript, environment, API secret, or unbounded prompt capture is part of the ledger.

## 9. Interfaces and Integrations

- **Session lifecycle boundary:** startup supplies immutable stage/provenance context before creating or resuming a `sessions` row; all terminal and recovery paths invoke the common non-blocking finalizer.
- **OMP adapter boundary:** the adapter supplies native lineage, event parsing, normalized usage/signals, and a durable range contract. It must report malformed, missing, truncated, or replaced sources rather than fabricating ownership.
- **Project-scoped history interface:** the main process exposes a structured task execution-history read operation through the existing project-scoped IPC/preload boundary. Its response is database-backed and does not implicitly load native transcript data.
- **Slice transcript interface:** a separate operation accepts a selected Kangentic session and resolves its persisted native slice for lazy transcript loading. It must not retain the current whole-task stitching semantics for this request.
- **Future controlled consumers:** review or MCP consumers may use structured history and slice transcript interfaces later. No review agent or automation is delivered here.
- **Analytics boundary:** existing aggregate remote analytics remains unchanged; this local ledger is not an expansion of Aptabase telemetry and must not transmit execution content or secrets.

## 10. Error and Edge-Case Behaviour

- **Missing or malformed native data:** preserve the session and any already durable structured data, record telemetry diagnostics, and mark the affected telemetry/transcript unavailable or partial. Do not block task movement or invent usage.
- **Truncation or replacement:** detect a source identity/boundary conflict and stop attribution at the safe known boundary. Never reuse timestamps alone to make overlapping ownership appear valid.
- **Resumed native sessions:** each Kangentic row receives its own durable range. Replayed native events must not create overlapping usage or transcript ownership, and repeated finalization must not duplicate records.
- **Interrupted, crashed, or suspended execution:** retain the immutable start snapshot and the last safe boundary, then allow reconciliation/finalization retry. Execution result remains distinct from telemetry state.
- **Unavailable fields:** provider, cost, timing, stage, and other unsupported values remain null/unknown. Known zero is reserved for a value explicitly reported as zero.
- **Collection/database failure:** collection errors are captured as diagnostics where possible and are isolated from the running agent and workflow transition. Later retry must use the same ownership/idempotency key.
- **Legacy sessions:** show legacy/unknown stage and available legacy aggregates; never infer historical stage from the task's current swimlane.
- **Nested tasks or sub-agents:** attribution and whether parent/child usage is included require an explicit policy before implementation; the design must prevent silent double counting.

## 11. Validation Considerations

Implementation validation should prove the following observable contracts:

- New, resumed, retried, moved, re-entered, interrupted, suspended, failed, and app-recovered executions retain the correct immutable stage snapshot and attempt value under the chosen attempt policy.
- Two Kangentic rows sharing one OMP native session receive deterministic non-overlapping ranges, including after replay, file replacement, and finalizer retry.
- Parser fixtures cover single and multiple providers/models, cache buckets, nullable costs, model switches, compactions, tool failures and recovery, nested activity, malformed/missing fields, and bounded native cursor slicing.
- Duplicate finalization leaves ownership, detail rows, aggregates, and read-model output unchanged; aggregate totals reconcile under documented token semantics.
- Collection or parsing failures do not prevent PTY completion or workflow movement, and restart recovery can finalize what remains safely attributable.
- History queries are project-scoped, chronological, filterable, and database-only on initial load. Transcript requests load only the selected slice and never silently fall back to the whole resumed native conversation.
- UI verification covers no history, one/many stages, active and archived states as product-approved, legacy/partial/unavailable records, failed execution with recovered tool errors, multi-model details, missing cost, long lists, and responsive/mobile layouts.
- Privacy checks confirm that full transcripts, environment data, API secrets, and unapproved prompt/config content are not captured or sent through the new history/analytics boundaries.

## 12. Open Questions

- What stable OMP event identity is guaranteed across supported versions: native event ID, append ordinal, byte offset, or a fallback combination? How should truncation or replacement be represented and recovered?
- How is a stage attempt defined for retry versus leaving and re-entering a stage, isolated tracks, concurrent sessions, and application recovery? What is the incrementing and uniqueness rule?
- How should existing lifecycle status, exit code, and suspension source map to execution result states such as success, failed, suspended, cancelled, interrupted, or unknown?
- Does OMP expose provider identity and authoritative cost on each usage event? If not, must cost remain null, or is an explicitly labeled estimate allowed?
- Are nested task/sub-agent usage and parent tool results included in the parent slice, represented in separate rows, or both with a reconciliation rule?
- Which provenance/context fields are allowed, and should system prompt or configuration references be hashes only? What exact secret/path redaction policy applies?
- Should History be visible for active tasks as well as archived tasks, and should its transcript detail reuse the current conversation viewer or introduce a slice-specific presentation?
- Is a structured MCP or other external `getTaskHistory` API required in the initial delivery, or only the internal read model needed for future review tooling?
- What list-size threshold, pagination policy, token display convention, and currency convention should the responsive history UI use?

## 13. Design Summary

- Keep `sessions` as the execution entity and add an additive per-project history ledger with immutable stage/provenance snapshots; preserve existing aggregate metrics as compatibility projections.
- Treat durable native OMP event-range ownership as a first-class concept so resumed Kangentic rows cannot overlap or double-count one native conversation.
- Normalize provider/model usage and execution signals while keeping execution result separate from telemetry status and diagnostics; finalization is idempotent, non-blocking, and retryable.
- Use a database-backed, project-scoped history read model first, and lazy-load only the selected native transcript slice after explicit user intent.
- Preserve legacy semantics and privacy boundaries, and resolve the explicitly listed product questions before fixing result mappings, native identity, attribution, provenance allowlisting, or pagination behavior.
