# Implementation Plan: Task Execution History and OMP Telemetry

## 1. Implementation Summary

Implement the approved HLD as an additive, per-project execution-history ledger attached to the existing `sessions` entity. The work spans project SQLite migrations and repositories, session startup and recovery, OMP parsing and durable slice ownership, non-blocking finalization, project-scoped read APIs, and a new task-detail History surface.

The sequence is dependency-sensitive: first settle the remaining repository-specific contracts in an LLD, then establish schema/domain contracts and shared provenance capture, implement OMP normalization and durable ownership, integrate one idempotent finalizer across every lifecycle path, and only then expose the read model and UI. Existing session aggregates, lifecycle semantics, and whole-task transcript behavior remain compatible throughout.

## 2. HLD Reference

The following HLD decisions constrain implementation:

- `sessions` remains the canonical Kangentic execution entity; new per-project child/detail records are additive and must preserve legacy rows and aggregate projections.
- Every newly inserted execution row captures immutable stage identity/name, stage configuration version or hash, allowlisted effective agent/profile/config provenance, and an explicit attempt value before task movement can change the current stage.
- OMP-backed rows require durable native lineage and non-overlapping ownership boundaries. In-memory cursors and `conversation_turn_usage` may support parsing or compatibility, but neither is the immutable slice authority.
- Provider/model usage, cache buckets, nullable cost, timings, signals, collection status/version, and diagnostics are distinct from execution result. Unknown values remain `NULL`/unknown rather than zero.
- One retryable, idempotent, non-blocking finalization path must cover success, failure, suspension, interruption, cancellation, exit/move, and crash/recovery without blocking PTY execution or workflow movement.
- Initial history reads are database-backed and project-scoped. A separate slice-transcript operation lazily parses only the selected native range; it must not change the existing whole-task transcript GET semantics.
- Full transcripts, environment data, API secrets, and unapproved prompt/configuration content are outside the new ledger and analytics boundary.

## 3. Repository Assessment

Repository inspection found the following implementation constraints and reusable components:

- Each project has an isolated SQLite database with synchronous repositories, foreign keys, WAL, and existing migration conventions. `sessions` already owns lifecycle state, native identifiers, and aggregate cost/token/model/tool/compaction fields.
- Session insertion occurs in both the normal transition-engine startup and automatic spawn/resume startup. Recovery/reconciliation can also create or finalize execution rows, so provenance capture must use one shared startup contract rather than one call-site patch.
- Existing metric capture and transcript-derived refinements are best-effort and distributed across metrics, suspend, move, exit, and reconciliation handlers. They preserve `NULL` for unavailable values but do not provide a durable idempotency boundary.
- The OMP adapter discovers native sessions from files and has separate session-history and transcript parsers. The parsers expose reusable normalized message/usage/tool events, but current in-memory cursors, file scans, and background retrieval indexing cannot establish immutable Kangentic ownership. Native files may be missing, malformed, truncated, replaced, or pruned.
- `conversation_turn_usage` transactionally deduplicates replayed UUIDs but can reassign a turn to the latest owner, so it is not suitable as the immutable slice ledger. The existing agent-agnostic conversation viewer can be reused for rendering a bounded slice.
- Existing IPC/preload channels expose session summaries and a whole-task transcript that intentionally stitches all sessions for a task. No structured execution-history read model or slice-specific transcript operation exists. The current task-detail UI has no History surface.
- Aptabase/remote analytics is intentionally aggregate and content-free; the local history ledger must remain separate. No material HLD conflict was found.

## 4. Implementation Approach

### 4.1 Establish the additive data and domain contracts

Add per-project migrations and repository operations around `sessions` for immutable provenance, attempt/result and telemetry state, native slice ownership, normalized usage, signals, and diagnostics. Keep existing columns and lifecycle APIs as compatibility projections. Define explicit indexes and foreign-key relationships for task/session chronology, stage/status filtering, provider/model breakdown, and native lineage lookups.

Repository transactions must make slice allocation, boundary updates, detail writes, aggregate reconciliation, and finalization idempotency atomic where they share an ownership key. Migration behavior must support fresh and upgraded project databases, with legacy sessions represented as unknown stage/provenance/result detail rather than inferred values. Exact table/column names, constraints, and transaction boundaries belong in the LLD.

### 4.2 Capture immutable provenance at every session-start boundary

Create a shared startup input/builder that records stage column ID/name, the effective stage configuration version/hash, an allowlisted agent/profile/config snapshot, and the chosen attempt value before any transition changes the task's current stage. Use it from direct transition startup, automatic spawn, resume, and restart/recovery paths that insert `sessions` rows. A later task move must never rewrite the stored snapshot.

Attempt semantics must be explicit for retries, leave/re-enter behavior, isolated tracks, concurrent starts, and recovery. Provenance capture must redact or hash fields according to the approved allowlist; it must not reuse existing broad command, cwd, prompt, or environment persistence without a privacy decision.

### 4.3 Normalize OMP events and assign durable native slices

Extend the OMP adapter boundary to expose stable native lineage/source identity, bounded event traversal, normalized provider/model usage (input, output, cache-read, cache-write, nullable cost, assistant-message/observation timing), and signals such as tool outcomes/errors, model changes, compactions, and assistant turns. Reuse normalized event parsing where safe, but keep native source identity and ownership separate from the existing retrieval cursor/index.

Introduce a durable allocator that reserves each Kangentic row's native range and records the source identity and safe start/end boundary. It must detect replacement/truncation and stop at the last safe boundary rather than using timestamps to manufacture ownership. Resumed rows sharing one OMP session must receive deterministic, non-overlapping ranges, including replay and finalizer retry. Nested task/sub-agent attribution must follow one documented policy and must not silently double-count parent and child usage.

The existing retrieval background parser/indexer must not cause initial History loads to parse native JSONL. The LLD must define whether slice-specific parsing gets a separate history path or a carefully reconciled shared path, while preserving lazy parsing after explicit transcript intent.

### 4.4 Integrate collection and idempotent finalization

Route success, failure, suspension, interruption, cancellation, process exit/move, crash reconciliation, and restart recovery through a common finalizer. It should snapshot all currently available normalized details and signals, close or preserve the safe native boundary, reconcile compatibility aggregates, record collection status/version/diagnostics, and derive execution result independently from telemetry health.

Finalization must be non-blocking to PTY and workflow transitions: collector, parser, native-file, and database failures are isolated, recorded where possible, and retryable with the same ownership/idempotency key. Repeated invocation must be a no-op or deterministic reconciliation that leaves ownership, detail rows, aggregates, and read-model output unchanged. Existing metric hooks may remain as compatibility projections but must not become competing finalization authorities.

### 4.5 Implement the structured history and slice-transcript access paths

Build a project-scoped, database-only history query returning chronological execution summaries and details, immutable provenance, result and lifecycle status, stage/status filters, provider/model usage, signals, diagnostics, and telemetry state. Define stable null/unknown representations and a bounded list/pagination contract in the LLD. Retain explicit project identity for every repository and IPC operation.

Add a distinct slice-transcript request keyed to the selected Kangentic session. It resolves the persisted native lineage and boundary, lazily parses only that bounded range after user action, and returns unavailable/partial diagnostics without changing the recorded execution result. Do not route this request through the existing task-wide transcript GET or silently fall back to the entire resumed native conversation. Keep any future MCP/review consumer out of scope unless the product decision explicitly adds a controlled read API.

### 4.6 Add the task-detail History surface

Add a History area distinct from Terminal, Browser, Changes, and Description. Render chronological executions with stage/status filtering, summary/result, provider/model breakdown, signals, immutable provenance, and separately displayed telemetry health. Represent active, completed, failed, suspended, legacy, partial, and unavailable states without converting absent values to zero.

Provide loading, empty, partial-data, failed-execution, and unavailable-transcript states; support long histories, multiple models, and narrow/mobile layouts. Initial render must use only the database history response. An explicit transcript action invokes the slice operation and reuses the conversation renderer only for the selected bounded slice. Active-task visibility, pagination presentation, and viewer specialization follow the product decisions recorded by the LLD.

### 4.7 Preserve compatibility and privacy boundaries

Keep legacy lifecycle statuses and aggregate session fields readable by existing consumers, and show unknown stage/result/provenance for old rows. Preserve whole-task transcript behavior and existing remote aggregate analytics. Add migration/read/API compatibility checks for projects with no new detail rows and for partially collected executions.

Enforce the provenance allowlist and redaction/hash rules at the capture boundary. Verify that the new local ledger, IPC payloads, slice transcript response, and analytics paths do not capture or transmit full transcripts, environment values, API secrets, unapproved prompts, or unbounded configuration content.

## 5. Implementation Sequence

1. **Complete the LLD and product decisions.** Resolve native event/source identity and replacement handling; stage-attempt and execution-result policies; provider/cost semantics; nested attribution; provenance allowlist/redaction; list/pagination and token/currency presentation; active-task History behavior; and whether any controlled external read API is in scope. Define the slice schema/indexes, transaction and idempotency contracts, and IPC/UI payload boundaries.
2. **Add and exercise additive project migrations and domain repositories.** Establish the immutable provenance, native ownership, normalized detail, signal, telemetry, and result records without replacing `sessions` or its aggregates. Add legacy/unknown handling and project-isolation query primitives.
3. **Implement shared startup provenance and attempt capture.** Integrate direct transition, auto-spawn, resume, and recovery insertion paths before movement can alter stage state; verify all new rows use the same contract.
4. **Implement OMP normalization and durable range allocation.** Add source identity, safe boundaries, normalized usage/signals, replacement/truncation diagnostics, and deterministic non-overlap for resumed native sessions. Keep existing retrieval usage deduplication as compatibility support only.
5. **Integrate the common finalizer across lifecycle and recovery paths.** Make collection non-blocking, idempotent, retryable, and independent of execution result; retain aggregate updates as projections.
6. **Expose database history and separate lazy slice-transcript IPC/preload operations.** Ensure initial history is JSONL-free and every operation is project-scoped; keep task-wide transcript GET unchanged.
7. **Build and exercise the History UI.** Add filtering, details, telemetry/result separation, explicit slice transcript loading, and all required loading/empty/partial/unavailable/responsive states.
8. **Run development integrity checks, then hand off to validation.** Check migration upgrades/fresh databases, type/API alignment, project isolation, compatibility projections, privacy boundaries, and the end-to-end lifecycle wiring before the separate validation stage runs its focused suites.

The order prevents UI/API contracts from depending on unstable schema or slice semantics and ensures all lifecycle paths share the same ownership and finalization rules before data is displayed.

## 6. Development Integrity Checks

Before validation, development should complete these repository-relevant checks:

- Apply the additive migration chain to a fresh project database and an upgraded legacy database; verify foreign keys, indexes, nullable unknown fields, and rollback/recovery behavior supported by repository conventions.
- Run the repository's formatter, lint, type-check, and compile/build integrity checks for changed main-process, preload/shared-contract, and renderer code.
- Verify IPC channel/preload/renderer type alignment and that project identity is required at every new repository and handler boundary.
- Exercise transaction/idempotency invariants with deterministic fixtures: allocation and finalization must not duplicate rows or overlap native ranges after retry.
- Perform a static/privacy review of captured provenance and serialized IPC/analytics payloads for forbidden transcript, environment, secret, path, prompt, or unapproved configuration data.

## 7. Validation Requirements

### Unit Validation

- Normalize OMP fixtures containing one and multiple providers/models, cache-read/cache-write buckets, nullable and explicit-zero values, timing fields, model switches, compactions, assistant turns, successful and failed tool calls, nested activity, malformed records, and missing fields without fabricating values.
- Resolve bounded native slices using the selected source identity and cursor/boundary; detect truncation/replacement and never fall back to timestamps alone or to the whole resumed conversation.
- Prove immutable stage/provenance snapshots and attempt values for each startup path, including retries, leave/re-enter, isolated tracks, concurrent-start policy, and recovery under the chosen semantics.
- Prove finalization is non-blocking, retryable, and idempotent across every terminal/recovery reason; duplicate calls must leave ownership, detail rows, aggregate projections, and read-model output unchanged.
- Verify execution result and telemetry status/diagnostics remain independent, unknown/null values remain distinguishable from known zero, and parent/child attribution reconciles under the documented policy.
- Verify history filters, chronological ordering, pagination/list limits, legacy handling, and project isolation against the read-model contract.

### End-to-End Validation

- Start, resume, retry, move, suspend, interrupt, cancel, fail, exit, crash, and recover executions through the actual transition/session lifecycle and confirm immutable provenance, attempt, result, telemetry, and aggregate compatibility behavior.
- Run two Kangentic rows against one resumed OMP native session and confirm deterministic non-overlapping ranges, correct normalized attribution, safe handling of replay/replacement, and unchanged results after finalizer retry.
- Load task History and confirm the initial request uses only structured database data; explicitly request a transcript and confirm only the selected slice is rendered while the existing whole-task transcript remains unchanged.
- Exercise no-history, active/archived, one/many-stage, legacy, partial/unavailable, failed-with-tool-error, multi-model, missing-cost, long-list, and narrow/mobile UI states.

### Other Relevant Validation

- Test migration compatibility and project isolation across multiple project databases, including legacy sessions with no new detail rows.
- Inject parser, missing-file, malformed-file, truncation/replacement, and database failures and verify PTY completion and workflow movement are not blocked; verify restart reconciliation can retry safe finalization.
- Inspect persisted and IPC/analytics payloads to confirm privacy constraints and absence of unapproved transcript, environment, secret, prompt, or configuration capture.
- Validate aggregate token/cost reconciliation against the documented provider and nested-attribution semantics, including unavailable cost remaining null.

## 8. Open Implementation Questions

The following questions must be resolved in the LLD or the explicitly identified product decision before implementation is considered complete:

- What stable OMP event identity is available across supported versions (native ID, append ordinal, byte offset, or a fallback), and how are source replacement, truncation, and pruning represented and recovered?
- What exact transaction schema and indexes provide atomic non-overlapping allocation, safe-boundary advancement, and idempotent finalization for resumed rows sharing a native session?
- How is an attempt numbered for retry, leave/re-enter, isolated tracks, concurrent sessions, and application recovery?
- How do lifecycle status, exit code, and suspension source map to execution-result states, and which evidence wins when recovery observes incomplete state?
- Does OMP provide authoritative provider and cost values per event? If not, must cost always remain null or may an explicitly labeled estimate be stored?
- Are nested task/sub-agent events included in the parent slice, stored separately, or represented in both places with a reconciliation rule?
- Which provenance fields are allowed, which references must be hashes, and what exact secret/path redaction policy applies?
- Should History be visible for active tasks, what pagination/list threshold and token/currency display rules apply, and should the slice transcript reuse or specialize the current conversation viewer?
- Should the initial delivery expose only internal project-scoped IPC or also a controlled structured external/MCP history API?
- How will the new lazy history-transcript path coexist with existing background native parsing and retrieval indexing without causing initial History loads to parse JSONL?

## 9. Low-Level Design Decision

**LLD required:** Yes

### Rationale

A separate LLD is required because this change crosses project migrations, the session state machine, OMP file parsing, durable ownership, distributed finalization, IPC/preload contracts, and renderer state. These components have coupled invariants and several choices are intentionally left open by the HLD; implementing them ad hoc would risk overlapping resumed slices, double-counting, mutable provenance, blocked lifecycle transitions, or accidental changes to whole-task transcript behavior.

The LLD must settle, with concrete repository-level contracts:

- native OMP identity/source fingerprints, stable event keys, boundary representation, replacement/truncation behavior, and the separation from in-memory cursors and `conversation_turn_usage`;
- normalized slice/detail schema, indexes, foreign keys, transaction boundaries, ownership allocation, safe-boundary updates, idempotency key, retry/reconciliation rules, and aggregate projection/reconciliation semantics;
- exact attempt and execution-result policies, lifecycle-to-result mapping, telemetry state/diagnostic taxonomy, nested task/sub-agent attribution, and provider/cost/null semantics;
- the immutable provenance allowlist, hashing/redaction rules, legacy unknown representation, and privacy enforcement points;
- the startup/finalizer call graph covering transition, auto-spawn, resume, suspend, move, exit, interruption, cancellation, and crash/recovery paths;
- project-scoped repository, IPC, preload, and renderer payload boundaries, including pagination/filtering and the separate task-wide versus slice-transcript operations;
- the History UI state/payload contract and the lazy transcript loading strategy relative to existing native retrieval/background parsing.

## 10. Implementation Checklist

- [ ] Complete the LLD and record all native identity, attempt, result, attribution, provenance, pagination, and API/UI contract decisions.
- [ ] Add additive per-project migrations, repositories, indexes, and legacy unknown handling while preserving `sessions` aggregates.
- [ ] Capture immutable stage/provenance snapshots and attempts from direct transition, auto-spawn, resume, and recovery insertion paths.
- [ ] Implement OMP normalization, durable non-overlapping slice ownership, source-integrity diagnostics, and bounded slice parsing.
- [ ] Integrate one non-blocking, retryable, idempotent finalizer across all terminal and crash/recovery paths.
- [ ] Add project-scoped database history and separate lazy slice-transcript IPC/preload contracts without changing whole-task transcript GET.
- [ ] Implement and verify the task-detail History surface and its partial, legacy, unavailable, responsive, and multi-model states.
- [ ] Complete compatibility, privacy, migration, project-isolation, and aggregate-integrity checks.
- [ ] Complete relevant development integrity checks and hand off the implementation summary for validation.
