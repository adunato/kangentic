# Low-Level Design: Task Execution History and OMP Telemetry

## 1. Change Overview

Implement an additive, project-local execution-history ledger attached one-to-one to the existing `sessions` row. `sessions` remains the canonical execution entity and all startup callers use `SessionRepository.createExecutionStart` as the sole public startup transaction authority: it opens `BEGIN IMMEDIATE`, allocates `MAX(stage_attempt)+1` for `(task_id, snapped_stage_id)`, inserts the queued `sessions` row, and calls `ExecutionHistoryRepository.insertStartInTransaction(tx, input)` for immutable provenance/history. The execution-history method never opens a transaction or allocates attempts. The ledger captures durable OMP source generations/slices, normalized usage/signals, separate execution-result and telemetry states, diagnostics, and idempotent finalization while preserving lifecycle columns, aggregate projections, whole-task transcript retrieval, and remote aggregate analytics.

The initial read path is a project-scoped SQL history query: `sessions` is `LEFT JOIN`ed to `session_execution_history`, so no migration backfill is required. A missing history row projects `{stage: Unknown, executionResult: unknown, telemetryStatus: unavailable, isLegacy: true}` while retaining existing aggregate metrics and chronological/filter inclusion rules. Native OMP content is read only by an explicit selected-slice request, bounded to 1 MiB and validated against persisted source identity, prefix, file identity, and closed-range hash. No production files are removed.

## 2. File Changes

### `src/main/db/migrations/project-schema.ts`

**Action:** Modify

Extend `runProjectMigrations` with idempotent additive DDL while retaining every existing `sessions` lifecycle, prompt/command, native-identity, and aggregate column. Foreign keys use `ON DELETE CASCADE` where stated below. The migration adds these exact tables:

- `session_execution_history`: `session_id` primary key/foreign key to `sessions(id)` cascade, `task_id`, snapped `stage_id`, `stage_name`, `stage_role`, `stage_attempt`, `board_profile_id`, `agent_id`, `session_type`, nullable `model`/`effort`, `permission_mode`, `config_hash`, `execution_result`, `telemetry_status`, and `started_at`/`finished_at`/created/updated timestamps. Enforce unique `(task_id, stage_id, stage_attempt)` and add keyset chronology `(task_id, started_at DESC, session_id DESC)` plus stage/result/telemetry filter indexes.
- `native_execution_sources`: `id` primary key; `native_session_id`; `canonical_path`; `canonical_header_hash`; `prefix_hash`; nullable `filesystem_identity`; `generation`; `durable_frontier` byte offset and its ordinal; `durable_frontier_hash`; `created_at` and `updated_at` timestamps; and source status. The source identity is uniquely keyed by `(native_session_id, canonical_path, generation)` (including the immutable generation), with indexes on `(native_session_id, canonical_path, generation)`, canonical path/header, and native-session lineage. The canonical path is ownership/validation metadata only: it is never provenance, displayed, or returned by a history API.
- `execution_slices`: `session_id` required foreign key to `sessions(id)` cascade and unique (each Kangentic session owns exactly one slice), required `source_id` foreign key to `native_execution_sources(id)` cascade, `[start_byte,end_byte)`, start/end ordinals, `state`, and immutable closed-range SHA-256. Enforce unique `(source_id,start_byte)` and a partial unique index on `source_id` for `state='open'`.
- `execution_model_usage`: `slice_id` foreign key cascade, `event_ordinal`, nullable provider/model, nullable input/output/cache-read/cache-write/cost, and nullable assistant observed time; unique `(slice_id,event_ordinal)`, with provider/model and slice/ordinal lookup indexes.
- `execution_signals`: `slice_id` foreign key cascade, `event_ordinal`, signal `type`, tool call ID/name, error flag, and timestamp; unique `(slice_id,event_ordinal)`, with slice/type/time and tool lookup indexes.
- `execution_telemetry_diagnostics`: required `session_id` foreign key to `sessions(id)` cascade, nullable `slice_id` foreign key to `execution_slices(id)` cascade (diagnostics may be session-level), deterministic `diagnostic_key`, severity, code, sanitized message, and byte/ordinal boundary; unique `(session_id,diagnostic_key)`, with session/slice/code/severity indexes.
- `execution_finalizations`: `session_id` primary key/foreign key cascade, deterministic `finalization_key = session_id`, reason, result, telemetry status, and finished timestamp. Session ID is the idempotency scope; add finalizer status/time indexes.

Legacy sessions receive no migration backfill. History SQL supplies their explicit unknown/unavailable projection. All DDL works for fresh and upgraded project databases under existing foreign-key/WAL conventions.

### `src/main/db/repositories/session-repository.ts`

**Action:** Modify

Expose `SessionRepository.createExecutionStart(input)` as the sole public startup transaction owner. It opens `BEGIN IMMEDIATE`, allocates `MAX(stage_attempt)+1` for `(task_id, snapped_stage_id)` (including retries, leave/re-entry, isolated tracks, concurrent starts, resumed native conversations, and recovery), inserts the queued `sessions` row, then calls `ExecutionHistoryRepository.insertStartInTransaction(tx, input)` to insert immutable provenance/history. `createExecutionStart` returns the exact session id and attempt. The execution-history method never opens a transaction and never allocates attempts.

Preserve existing insert defaults and aggregate fields. Direct transition, automatic spawn, resume, and recovery callers must all use this API; no caller may independently insert `sessions`, history, or “latest task row” data. Add exact-id lookup and non-startup helpers for ownership/finalization without replacing `compareAndUpdateStatus`, aggregate metric updates, recovery queries, or summary rollups.

### `src/shared/types.ts`

**Action:** Modify

Add shared domain and IPC contracts for `ExecutionResult` (`unknown`, `in_progress`, `succeeded`, `failed`, `suspended`, `cancelled`, `interrupted`) and `TelemetryStatus` (`pending`, `collecting`, `complete`, `partial`, `unavailable`, `failed`). Add immutable `ExecutionProvenance`, `ExecutionHistorySummary`, `ExecutionHistoryDetail`, `ExecutionUsageBreakdown`, `ExecutionSignal`, `ExecutionDiagnostic`, cursor/filter/request/response types, and `ExecutionSliceTranscriptRequest/Response` types.

History reads require explicit `projectId` and `taskId`, use `sessions LEFT JOIN session_execution_history`, include legacy rows explicitly, and keyset paginate by `started_at DESC, session_id DESC`. The opaque cursor is base64url JSON `{startedAt,sessionId}` validated with the same filters; default `limit` is 50 and maximum is 100. Slice responses distinguish `unavailable`, `source_changed`, and `partial` from valid bounded `TranscriptEntry[]` data. Startup types expose only approved provenance/non-secret fields; provenance never stores a task path, workspace path, configuration path, or any other path. `native_execution_sources.canonical_path` is internal native-source ownership/validation metadata only and is never displayed or returned by history APIs. Preserve existing `SessionRecord`, `SessionUsage`, `TranscriptGetRequest`, and whole-task transcript semantics.

### `src/shared/ipc-channels.ts`

**Action:** Modify

Add distinct constants for database history and selected-slice transcript operations, such as `EXECUTION_HISTORY_GET` and `EXECUTION_SLICE_TRANSCRIPT_GET`. The new constants must not alter `TRANSCRIPT_GET` or `TRANSCRIPT_LIST_SESSIONS`, whose existing operation remains whole-task and session-list compatible.

### `src/main/db/repositories/execution-history-repository.ts`

**Action:** Create

Own all project-scoped execution-history SQL except startup transaction ownership. Provide `insertStartInTransaction(tx, input)` as a transaction-participant only (it performs no `BEGIN` and no attempt allocation), plus `reserveSlice`/checkpoint operations, normalized usage/signal/diagnostic upserts, explicit-result/telemetry updates, idempotent finalization records, and chronological history queries with stage/result/telemetry filters and cursor pagination.

`reserveSlice` runs in `BEGIN IMMEDIATE`. It finds the latest source by `(native_session_id, canonical_path)`, compares supplied header hash, prefix hash, and file identity, and, when no filesystem identity is available, hashes bytes `[0,durable_frontier)` and compares `durable_frontier_hash`; a mismatch or observed size below the frontier creates generation `MAX(generation)+1` in the same transaction. The source row is unique on `(native_session_id, canonical_path, generation)`. A session attachment either closes a prior active slice at its committed frontier through that exact session's idempotent finalizer or defers/fails; it never creates a second open slice. Each session owns exactly one slice. If replacement or shrink is detected while that slice is open, atomically close it at its last committed frontier with `telemetryStatus=partial` and a `source_changed` diagnostic; do not allocate another slice to that session. A later resumed/new Kangentic session reserves the next slice in the new generation. The partial unique open-slice index is the database backstop.

An inserted slice starts at the committed frontier. Checkpoint/close advances `durable_frontier` and sets `durable_frontier_hash` to the supplied SHA-256 of bytes `[0,durable_frontier)` while ending the slice with a conditional `UPDATE ... SET durable_frontier=?, durable_frontier_hash=? WHERE durable_frontier = expected`; zero rows reload the source and retry. Parser, file, and hash I/O occur outside the transaction, but reservation/checkpoint compares all supplied evidence inside it. Every closed exact `[start_byte,end_byte)` range stores its SHA-256, and serving a closed slice verifies that hash. All operations accept an explicit project DB and exact ids; queries return SQL-only summaries/details, preserve `NULL` for unavailable provider/cost/timing/token buckets, left-join legacy sessions, and apply identical filters to cursor pages. Finalization is keyed by `session_id` (`finalization_key = session_id`) and is a deterministic no-op/reconciliation on retries; child rows are scoped to the exact owning session/slice.

### `src/main/execution-history/provenance.ts`

**Action:** Create

Define the startup input and builder for the only hashed canonical configuration object: `{ version: 1, boardProfileId, stage: { id, name, role }, effective: { agentId, sessionType, model, effort, permissionMode, autoSpawn, sessionTarget, spawnStrategy } }`. Stable-sort every object key, serialize as UTF-8 JSON, and hash with SHA-256 into `config_hash`. Persist the separately listed non-secret identity fields plus the hash; discard every other configuration key.

Missing optional values serialize as `null`. Malformed or unserializable allowlisted fields are omitted, recorded as a sanitized diagnostic, and never block start. Provenance must never store a task path, workspace path, configuration path, prompt, command, cwd, environment, tool arguments/results, or raw configuration. The native source canonical path is not provenance and is not returned by history APIs. The builder runs before task movement and returns the immutable context consumed by `SessionRepository.createExecutionStart`; legacy rows are not backfilled from the current task stage.

### `src/main/execution-history/native-slice-ownership.ts`

**Action:** Create

Implement durable OMP source/range ownership independent of `SessionHistoryReader` cursors and `conversation_turn_usage`. Before repository calls, native I/O resolves the path with `fs.realpath`, then normalizes it to an absolute path using `/` separators and lowercases only the Windows drive letter. It parses the first complete header JSONL record and recursively sorts object keys while preserving original JSON scalar types, serializes with no whitespace as UTF-8, and hashes that canonical JSON with SHA-256. It computes the prefix hash as SHA-256 of the first `min(64 KiB, file size)` bytes and records filesystem identity as `dev:ino` only when the platform provides both values, along with observed size, parser boundaries, and the durable-prefix hash evidence. These native I/O and hash operations are outside transactions.

`reserveSlice` uses `BEGIN IMMEDIATE`, finds the latest source by native session id and canonical path, and compares header hash, prefix hash, and file identity. If no filesystem identity is available, it hashes bytes `[0,durable_frontier)` and compares the supplied hash with `durable_frontier_hash`; any mismatch or size below the frontier creates immutable generation `MAX(generation)+1` in the same transaction. This detects same-header/path/prefix replacements without file identity at attachment/checkpoint, rather than waiting until serving. A new session's inserted slice starts at the committed frontier; a checkpoint conditionally advances `durable_frontier`, sets `durable_frontier_hash` to the supplied hash of `[0,durable_frontier)`, and ends the slice only when `durable_frontier = expected`, otherwise it reloads and retries. A partial unique index allows only one `state='open'` slice per source.

Each Kangentic session owns exactly one slice. If attachment finds an existing open slice for that exact session, it must not create another. If source replacement or shrink is detected while that slice is open, atomically close it at its last committed frontier through that exact session's idempotent finalizer, set `telemetryStatus=partial`, and write a `source_changed` diagnostic; do not allocate another slice to the session. If another session has the prior active slice, attachment must close it at its committed frontier through that exact session's finalizer or defer/fail, never creating a second open slice. A later resumed/new Kangentic session reserves the next slice in the new generation. Every closed exact byte range stores its SHA-256, which serving validates before parsing; missing/malformed input stops at the last safe frontier and writes sanitized diagnostics.

### `src/main/execution-history/omp-telemetry-collector.ts`

**Action:** Create

Consume normalized OMP history events and `SessionManager`/`SessionTelemetry` snapshots for the one slice owned by the exact session, then persist usage and signals through `execution-history-repository`. Normalize provider/model input, output, cache-read, cache-write, nullable cost, assistant-message timing, observation timing, tool start/end/error, model changes, compactions, assistant turns, and diagnostics without converting unknown values to zero. Supply the parser/hash evidence required by `reserveSlice` and checkpoint; the repository performs generation and frontier decisions transactionally.

Provider and cost are written only when OMP explicitly supplies them. A sub-agent's usage belongs to its own session; a parent receives only the corresponding tool-result signal. Collection checkpoints use the committed frontier and conditional update; zero-row conflicts reload/retry. If replacement or shrink is detected for an open slice, close that exact session's slice at its last committed frontier with `telemetryStatus=partial` and a `source_changed` diagnostic, never attach a second slice to the session. Collector errors are captured as sanitized diagnostics and do not throw into PTY or workflow code.

### `src/main/execution-history/execution-finalizer.ts`

**Action:** Create

Provide the single retryable finalization authority for exact session record ids. Accept `{ sessionRecordId, reason, exitCode?, lifecycleEvidence? }`; derive deterministic `finalization_key = sessionRecordId` (the session ID is the idempotency scope), collect the latest safe slice/telemetry facts, map normal exit 0 to `succeeded`, nonzero to `failed`, intentional pause/stage stop to `suspended`, explicit reset to `cancelled`, and shutdown/crash/orphan recovery to `interrupted`, then persist execution result independently from telemetry status.

The finalizer also owns idempotent closure of an exact session's one slice at its committed frontier. On source replacement/shrink while that slice is open, it atomically closes that slice, sets telemetry status to `partial`, and writes a nullable-or-slice-linked `source_changed` diagnostic without allocating a replacement slice. Finalization is non-blocking to PTY and workflow movement: catch parser/native/DB failures, record sanitized diagnostics where possible, and leave a retryable `pending`/`partial`/`failed` telemetry state. Repeated calls with the same session ID are deterministic no-op/reconciliation calls; they cannot overlap slices, duplicate detail rows, or change compatibility aggregate projections. Legacy rows remain `unknown` result with `unavailable` telemetry.

### `src/main/agent/adapters/omp/session-history-parser.ts`

**Action:** Modify

Extend the OMP header and normalized event output with the first complete header record's canonical JSON SHA-256, normalized absolute realpath, first-`min(64 KiB,file size)` prefix SHA-256, optional filesystem identity, observed size, event ordinal/byte boundaries, and provider/cost fields only when explicitly present. Canonical identity is produced by `fs.realpath`, absolute `/`-separator normalization, and lowercasing only the Windows drive letter; the first complete header JSONL record is recursively key-sorted, serialized without whitespace preserving original scalar types as UTF-8, and SHA-256 hashed. Filesystem identity is `dev:ino` only where both are provided. Preserve current v3 validation, exact-cwd capture for existing behavior, append/full parsing, malformed-line tolerance, and resume safety; existing exact-cwd behavior remains outside the new provenance/history records, and source metadata is ownership metadata, never provenance or returned history data.

The parser is not the ownership authority: native I/O and hashing report metadata/events to `native-slice-ownership` and the collector, while `reserveSlice`/checkpoint perform the `BEGIN IMMEDIATE` generation, exact-session one-slice, frontier, and predecessor decisions. Parser/native I/O/hash work is outside those transactions.

### `src/main/agent/adapters/omp/transcript-parser.ts`

**Action:** Modify

Add a bounded selected-slice parse result accepting persisted source id/generation, canonical path (internal only), header/prefix/file-identity fingerprints, byte/ordinal range, state, and persisted frontier. Before mapping JSONL to `TranscriptEntry`, validate all source fingerprints and the immutable closed-range SHA-256; recompute and verify the closed range for every serve (including when filesystem identity is unavailable). Return `unavailable` or `source_changed` on failure, never another session or whole-task fallback, and never expose canonical path in the response.

Reuse bounded JSONL/window machinery. Open slices use persisted frontier as the end, report `partial`, and never read beyond 1 MiB. Closed slices hash and validate the exact `[start_byte,end_byte)` bytes before serving. Preserve full transcript parsing and `TRANSCRIPT_GET` unchanged.

### `src/main/agent/adapters/omp/omp-adapter.ts`

**Action:** Modify

Expose the OMP-specific source identity, bounded event traversal, normalized telemetry event, and selected-slice transcript capabilities through `OmpAdapter.runtime`. Keep `sessionType` and existing locate/resume behavior compatible, and route all ownership through the new allocator rather than the adapter's in-memory resume cursor.

### `src/main/agent/agent-adapter.ts`

**Action:** Modify

Extend the generic adapter contract with optional source-integrity metadata, normalized history-event traversal, and bounded selected-slice parsing so execution-history code remains adapter-agnostic. Existing adapters can report unsupported provider/cost/source fields as `NULL`/unavailable; do not add agent-name branching to shared lifecycle code.

### `src/main/pty/readers/session-history-reader.ts`

**Action:** Modify

Retain existing attach, append/full-rewrite, truncation, detach, and failure-degradation behavior while emitting safe boundary/checkpoint metadata to the collector and ownership component. The reader may continue using its in-memory cursor and `startAtEnd` resume behavior, but it must not allocate or reassign durable Kangentic slices.

### `src/main/activity-engine/usage-accumulator.ts`

**Action:** Modify

Add normalized usage/event hooks that feed the durable collector while preserving current activity decisions, in-memory accumulation, and compatibility metric consumers. Keep missing provider/cost/timing values unknown and ensure nested activity is attributed to the owning child session according to the parent tool-result-only policy.

### `src/main/activity-engine/session-telemetry.ts`

**Action:** Modify

Expose collector-safe snapshots and normalized event callbacks for assistant timing, tools, model changes, compactions, and errors. Continue serving live activity/UI caches; durable result and telemetry status are owned by the finalizer/repository, not by this in-memory component.

### `src/main/transition-engine/transition-engine.ts`

**Action:** Modify

At `executeTransition`/`executeSpawnAgent`, build destination-stage provenance before task movement can change the current lane, then call `SessionRepository.createExecutionStart` with that context before PTY launch. Promote/update the exact returned session id after launch; direct transition startup must not call a lower-level insert or history transaction.

On spawn failure, call the common finalizer with the exact id and explicit interruption/failure reason rather than leaving a post-spawn-only insertion gap.

### `src/main/transition-engine/session-startup/prepare-spawn.ts`

**Action:** Modify

Extend `PreparedSpawn`/`prepareAgentSpawn` to carry the shared immutable provenance input and snapped stage identity/profile context to `SessionRepository.createExecutionStart`, along with adapter, native id, model, and effort needed by existing spawn execution. This is the common preparation seam for direct, automatic, resumed, and recovery starts; it does not allocate attempts or open a transaction.

The prepared context excludes forbidden raw command/cwd/environment/prompt data from the new ledger even though existing spawn execution may still need those values in memory.

### `src/main/transition-engine/session-startup/auto-spawn.ts`

**Action:** Modify

For each automatic start, call `SessionRepository.createExecutionStart` before launching its PTY, using the prepared context; the API allocates the attempt and invokes `insertStartInTransaction` inside the same transaction. Preserve parallel spawn behavior only after rows are queued, then promote/update each returned exact session id and finalize failed launches.

### `src/main/transition-engine/session-startup/resume-suspended.ts`

**Action:** Modify

Call `SessionRepository.createExecutionStart` before every resumed/recovered launch. A resumed native OMP conversation always receives a new Kangentic session row and allocated `stage_attempt`; the retired row, its source generation, and closed slices remain immutable. Recovery/orphan decisions use the common finalizer with `interrupted` when shutdown/crash evidence, rather than intentional pause, is observed.

### `src/main/transition-engine/session-lifecycle.ts`

**Action:** Modify

Keep existing CAS status transitions as the lifecycle source of truth, but pair every terminal, suspend, retire, promote, and stale-id recovery path with an explicit finalizer reason and exact session record id. This file must not derive history by querying the latest task row or overwrite immutable provenance.

### `src/main/pty/lifecycle/session-spawn-flow.ts`

**Action:** Modify

Start/stop collector and boundary checkpoint handling at the PTY process boundary, retaining current telemetry/readers, hook cleanup, file preservation, and `SessionManager` exit events. Ensure process exit can flush the last safe collector state before publishing the lifecycle event, while any collector failure remains best effort.

### `src/main/pty/session-manager.ts`

**Action:** Modify

Expose the exact record/native-session association and final in-memory usage/activity/event snapshot needed by the collector before exit cleanup. Preserve existing telemetry callback routing, agent-session-id attachment, cache cleanup, and event APIs; the manager must not own durable history transactions.

### `src/main/ipc/handlers/session-reconcile.ts`

**Action:** Modify

Route `applySuspendDbWrites` and settings/restart reconciliation through the common finalizer with explicit `suspended`, `cancelled`, or `interrupted` reasons as appropriate. Retain synchronous aggregate/git-churn compatibility projections and asynchronous transcript refinements, but make them subordinate to the exact-session finalization key.

### `src/main/ipc/handlers/sessions.ts`

**Action:** Modify

Integrate finalization into `SESSION_SUSPEND`, `SESSION_RESET`, session-changed promotion, and `SessionManager` exit listeners. Map normal exit code 0 to succeeded, nonzero to failed, intentional user pause/stage stop to suspended, reset to cancelled, and shutdown/crash/orphan recovery to interrupted. Existing broadcasts and CAS status writes remain unchanged in shape.

### `src/main/ipc/handlers/task-move.ts`

**Action:** Modify

Replace competing move-to-done, auto-spawn-disabled, isolation-switch, and repeated suspend metric/status completion branches with calls to the common idempotent finalizer. Preserve task `session_id` clearing, git churn, and workflow movement; finalization failures must not block the move.

### `src/main/ipc/handlers/project-relocate.ts`

**Action:** Modify

When relocation suspends or retires sessions, provide the finalizer with exact session ids and an explicit intentional-stop reason. Do not copy provenance or native ranges into the destination project; project DB isolation remains strict and existing relocation behavior stays compatible.

### `src/main/ipc/handlers/auto-spawn-reconcile.ts`

**Action:** Modify

Route auto-spawn reconciliation and failed/recovered launches through the same `SessionRepository.createExecutionStart` and finalizer contracts as normal auto-spawn. Distinguish intentional suppression from crash/orphan recovery; never allocate an attempt or insert startup history independently, and preserve one attempt per newly created session.

### `src/main/ipc/handlers/session-metrics.ts`

**Action:** Modify

Keep `captureSessionMetrics`, transcript token/tool refinements, and `usage_history` writes as compatibility projections. Add collector/finalizer invocation where lifecycle code needs a snapshot, preserve null semantics, and prevent these best-effort methods from becoming a second finalization authority or changing aggregate rollups.

### `src/main/ipc/handlers/metrics-snapshot-timer.ts`

**Action:** Modify

Continue periodic snapshots for running sessions and add a safe-boundary/telemetry checkpoint for active history rows where available. Timer failures are isolated; checkpoints use the same ownership key and must not finalize or duplicate detail rows.

### `src/main/ipc/register-all.ts`

**Action:** Modify

Register the new execution-history IPC handler alongside existing session/transcript handlers and retain the metrics snapshot timer registration. No existing channel registration is renamed or removed.

### `src/main/ipc/handlers/execution-history.ts`

**Action:** Create

Implement project-scoped handlers for `EXECUTION_HISTORY_GET` and `EXECUTION_SLICE_TRANSCRIPT_GET`. History requires `projectId` and `taskId`, uses `sessions LEFT JOIN session_execution_history`, explicitly includes/excludes legacy rows under the same stage/result/telemetry filters, and keyset orders `started_at DESC, session_id DESC`. The opaque cursor is base64url JSON `{startedAt,sessionId}`, validated against identical filters; default limit is 50 and maximum is 100. Initial history reads are SQL-only and never open native files or return source canonical paths.

For a selected session slice, resolve the exact persisted `execution_slices.source_id` and `native_execution_sources` row, then validate the internal canonical path (resolved with `fs.realpath`, absolute `/` separators, and only Windows-drive-letter lowercasing), complete-header canonical hash, first-`min(64 KiB,file size)` prefix hash, optional `dev:ino` identity, and closed range's exact SHA-256 before bounded parsing. Open slices use persisted frontier as end, return `partial`, and never read beyond 1 MiB. Any validation/read/parse failure returns source state `unavailable` or `source_changed` (with diagnostics), never a whole-task fallback or altered execution result; canonical path is never in the response.

### `src/preload/preload.ts`

**Action:** Modify

Expose typed `executionHistory.get` and `executionHistory.getSliceTranscript` methods through `ipcRenderer.invoke`, using the new channels and shared request/response contracts. Keep the existing `api.transcripts.get` and `listSessions` methods and their whole-task behavior unchanged.

### `src/renderer/window-manager/components/TaskDetailWindow.tsx`

**Action:** Modify

Add separate History selection/detail state or pass-through props without reusing `conversationSessionId` or the task-wide conversation toggle. Keep existing Browser, Changes, Description, terminal, and archived state transitions intact and supply explicit project/task identity to the History panel.

### `src/renderer/components/dialogs/task-detail/TaskDetailHeader.tsx`

**Action:** Modify

Add a distinct History affordance/menu item next to existing task-detail controls. It must not masquerade as the Conversation pill and must route selected execution transcript actions through the new panel/API rather than `transcripts.get`.

### `src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx`

**Action:** Modify

Render `ExecutionHistoryPanel` as a distinct task-detail surface for active and archived tasks while preserving terminal, queued, preparing, suspended, changes, description, and archived summary branches. The panel receives explicit project/task ids and does not change the current whole-task conversation rendering.

### `src/renderer/components/dialogs/task-detail/task-detail-host.tsx`

**Action:** Modify

Thread the explicit project/task identity and History surface callbacks through the task-detail host without importing ambient project/board stores. Preserve the host decoupling contract covered by its existing unit test.

### `src/renderer/components/dialogs/task-detail/ExecutionHistoryPanel.tsx`

**Action:** Create

Provide the structured History UI: chronological rows, stage/result/telemetry filters, cursor pagination, summary and immutable provenance, provider/model usage, signals, diagnostics, and separately displayed execution result versus telemetry status. Own loading, empty, partial-data, failed-execution, unavailable-transcript, long-list, multi-model, and narrow-layout states.

Initial mount calls only `executionHistory.get`. An explicit selected-row transcript action calls `getSliceTranscript`, renders only returned bounded entries through `ConversationView`, and displays unavailable/source-changed diagnostics without changing the recorded result. No separate hook or detail component is planned because this panel can own the small request/filter/selection state without duplicating task-detail patterns.

### `src/renderer/components/dialogs/SessionSummaryPanel.tsx`

**Action:** Modify

Retain the archived aggregate summary and existing “View full conversation” action. Add or preserve a separate affordance into the execution History surface without routing the existing conversation action through slice APIs or changing summary aggregate semantics.

### `tests/unit/execution-history-repository.test.ts`

**Action:** Create

Exercise fresh/upgraded schema behavior, project isolation, startup atomicity, monotonic attempts and unique constraints, immutable provenance (including rejection of task/workspace/config paths), exact source schema/FKs/indexes, chronological/filterable/cursor-paginated reads, null/unknown values, child cascade semantics, and idempotent finalization/detail upserts. Use at least two project DBs to prove no cross-project reads.

### `tests/unit/native-slice-ownership.test.ts`

**Action:** Create

Prove exact canonical identity normalization and complete-header canonical JSON hashing, `min(64 KiB,file size)` prefix hashing, optional `dev:ino`, generation increments on replacement or shrink below the durable frontier (including durable-prefix hashing without file identity), `BEGIN IMMEDIATE` reservation, transactional non-overlap, one slice per session, one open slice per source, byte and ordinal boundaries, conditional frontier retry, safe-frontier advancement, closed-range hashes on serve, source-change partial closure/diagnostics, missing/malformed source diagnostics, and retry behavior with the same ownership key.

### `tests/unit/execution-finalizer.test.ts`

**Action:** Create

Exercise every explicit finalization reason and result mapping, including success, nonzero failure, intentional suspension, reset cancellation, interruption, crash/orphan recovery, and legacy unknown. Verify separate telemetry states, retry/non-blocking error isolation, exact-session targeting, one-slice ownership, source-change closure at the committed frontier with `partial` telemetry and diagnostic, unique-key idempotency, unchanged aggregates/detail rows after duplicate finalization, and later retry of partial collection.

### `tests/unit/omp-session-history-parser.test.ts`

**Action:** Modify

Extend existing OMP parser fixtures for exact realpath/absolute-slash/drive-letter normalization, complete-header canonical JSON and prefix fingerprints, optional filesystem identity, observed size and event boundaries, provider identity only when explicitly present, nullable versus explicit-zero cost, cache buckets, assistant timing, model changes, compactions, tool errors/recovery, nested child attribution signals, malformed fields, and bounded slice parsing. Preserve all current v3/cwd/resume and malformed-line expectations.

### `tests/unit/history-ipc-handler.test.ts`

**Action:** Create

Verify explicit project/task requirements, filters, default/max limits, cursor behavior, chronological SQL-only initial reads, no native file/retrieval-index invocation, and no canonical path in returned history data. Separately verify selected-slice requests validate the persisted source/FKs/fingerprints/range hash and return bounded entries or unavailable/source-changed diagnostics without invoking whole-task `TRANSCRIPT_GET`.

### `tests/ui/task-history.spec.tsx`

**Action:** Create

Cover the History surface's loading, empty, active/archived, one/many-stage, filtering, result-versus-telemetry, legacy, partial, failed-with-tool-error, unavailable-transcript, multi-model, long-list, and narrow/mobile states. Assert the explicit transcript action renders only the selected slice and missing values are not shown as zero.

### `tests/e2e/task-execution-history.spec.ts`

**Action:** Create

Drive actual start, resume, retry, move, suspend, interrupt, cancel, failure, shutdown/crash recovery, and selected bounded OMP transcript flows. Verify immutable stage/provenance and attempts, one slice per Kangentic session, non-overlapping resumed slices, generation allocation at attachment/checkpoint, source-change partial closure at the committed frontier, finalizer retry stability, project scope, and unchanged whole-task transcript behavior.

## 3. Cross-File Dependencies

1. `project-schema.ts` establishes the exact additive tables. `native_execution_sources` has `id` primary key, `native_session_id`, `canonical_path`, `canonical_header_hash`, `prefix_hash`, nullable `filesystem_identity`, `generation`, `durable_frontier` byte/ordinal, `durable_frontier_hash`, and `created_at`/`updated_at` timestamps; uniqueness is `(native_session_id, canonical_path, generation)`. `execution_slices.source_id` is a required FK to that id, `session_id` is required/cascade and unique per session, diagnostics retain required session/cascade plus nullable slice/cascade FKs, and the one-open-slice partial index, range uniqueness, and lookup/keyset indexes are consumed by `execution-history-repository.ts`; all operations receive the DB opened for the explicit project id.
2. `provenance.ts` and `prepare-spawn.ts` build the allowlisted immutable startup context. Provenance never stores task, workspace, or configuration paths; `native_execution_sources.canonical_path` is separate internal ownership/validation metadata and is never displayed or returned by history APIs. Direct transition, automatic spawn, resume, and recovery callers all invoke `session-repository.ts` `createExecutionStart`; it alone opens `BEGIN IMMEDIATE`, allocates `MAX(stage_attempt)+1`, inserts `sessions`, and invokes `insertStartInTransaction`. The history method never begins a transaction or allocates attempts.
3. `omp-session-history-parser.ts`, `transcript-parser.ts`, `omp-adapter.ts`, `agent-adapter.ts`, and `session-history-reader.ts` supply source metadata and normalized bounded events. Native I/O resolves with `fs.realpath`, normalizes absolute `/` separators and only the Windows drive letter's case, canonicalizes the first complete header JSONL record by recursively sorting object keys and compact UTF-8 serialization while preserving scalar types, hashes that JSON and the first `min(64 KiB,file size)` bytes, and records `dev:ino` only when both are available. This I/O/hashing is outside transactions.
4. `native-slice-ownership.ts` and `execution-history-repository.ts` implement `reserveSlice` with `BEGIN IMMEDIATE`: find the latest native-id/path source, compare header/prefix/file identity, or hash `[0,durable_frontier)` and compare `durable_frontier_hash` when identity is unavailable; any mismatch or shrink below frontier creates generation `MAX(generation)+1` in the same transaction. A new session starts at the committed frontier; conditional frontier updates use `WHERE durable_frontier = expected` and zero rows reload/retry. An exact session owns exactly one slice, an open source has at most one slice, and source replacement/shrink closes an open slice at its committed frontier with partial telemetry and `source_changed` rather than allocating a second slice to that session. A prior active slice must be closed by its exact idempotent finalizer or attachment defers/fails. Every closed range stores and serving verifies its exact byte-range SHA-256.
5. `session-manager.ts`, activity telemetry files, and `session-spawn-flow.ts` expose live snapshots/checkpoints. `sessions.ts`, `session-reconcile.ts`, `task-move.ts`, `project-relocate.ts`, `auto-spawn-reconcile.ts`, lifecycle code, and metrics hooks all call the one `execution-finalizer.ts` with the exact session id and session-scoped idempotency key; a later resumed/new Kangentic session, not the closed session, reserves the next slice in a new generation.
6. `execution-finalizer.ts` combines collector output, safe ownership boundaries, result mapping, telemetry diagnostics, and existing aggregate projections through repository transactions. It atomically closes source-changed open slices at their last committed frontier with `telemetryStatus=partial` and a `source_changed` diagnostic, without creating a replacement slice for that session. It must never synchronously throw into a PTY exit or workflow transition; execution result remains independent of telemetry status.
7. `shared/types.ts` and `shared/ipc-channels.ts` define the contract consumed by `execution-history.ts`, `register-all.ts`, `preload.ts`, and `ExecutionHistoryPanel.tsx`. Initial history is a filtered, legacy-inclusive SQL `LEFT JOIN`, keyset ordered `started_at DESC, session_id DESC` with base64url `{startedAt,sessionId}` cursors; selected transcript parsing is separate, bounded, source-validated, and never returns canonical paths.
8. `ExecutionHistoryPanel.tsx` may reuse `ConversationView` only for returned selected-slice entries, but `ConversationWindow.tsx`, `transcripts.ts`, `transcript-service.ts`, `conversation-indexer.ts`, and `conversation-usage-store.ts` retain whole-task/retrieval behavior and are not ownership authorities. Remote `analytics.ts` remains aggregate/content-free; no prompt, command, cwd, task/workspace/config path, environment, tool arguments/results, or raw config enters provenance/history, while the internal native canonical path is used solely for source ownership and slice validation.

## 4. File Change Summary

| File | Action | Purpose |
| --- | --- | --- |
| `src/main/db/migrations/project-schema.ts` | Modify | Add exact additive history/source/slice/usage/signal/diagnostic/finalization tables, including source id/FKs, generation/frontier evidence, one-session/one-open-slice constraints, and lookup/keyset indexes without backfill. |
| `src/main/db/repositories/session-repository.ts` | Modify | Sole `BEGIN IMMEDIATE` startup owner; allocate stage attempts, insert queued session, and invoke transactional history participant. |
| `src/shared/types.ts` | Modify | Result/telemetry, legacy projection, privacy-separated provenance/source metadata, history cursor/filter, slice, and startup contracts. |
| `src/shared/ipc-channels.ts` | Modify | Add distinct history and selected-slice channels. |
| `src/main/db/repositories/execution-history-repository.ts` | Create | Project-scoped SQL, transaction participant, exact `reserveSlice`/frontier procedure, source/slice/detail persistence, legacy-aware reads, and finalization. |
| `src/main/execution-history/provenance.ts` | Create | Exact v1 allowlist canonicalization, SHA-256 hash, and sanitized non-blocking diagnostics; never persist task/workspace/config paths. |
| `src/main/execution-history/native-slice-ownership.ts` | Create | Exact realpath/header/prefix/file-identity normalization, immutable generation allocation, one-session/one-open-slice ownership, conditional frontier advancement, and closed-range hashing. |
| `src/main/execution-history/omp-telemetry-collector.ts` | Create | Normalize and persist OMP usage, timings, signals, and diagnostics with source evidence/checkpoints and source-change partial closure. |
| `src/main/execution-history/execution-finalizer.ts` | Create | Single non-blocking, retryable, session-idempotent lifecycle/recovery finalizer and exact one-slice source-change closure. |
| `src/main/agent/adapters/omp/session-history-parser.ts` | Modify | Emit exact OMP source identity, canonical header/prefix hashes, boundaries, and supported normalized fields. |
| `src/main/agent/adapters/omp/transcript-parser.ts` | Modify | Validate internal persisted source evidence and closed-range hashes, then parse bounded slices without returning canonical paths. |
| `src/main/agent/adapters/omp/omp-adapter.ts` | Modify | Expose OMP ownership and slice capabilities. |
| `src/main/agent/agent-adapter.ts` | Modify | Add generic bounded source-integrity/slice capability. |
| `src/main/pty/readers/session-history-reader.ts` | Modify | Feed safe collector checkpoints while retaining cursor behavior. |
| `src/main/activity-engine/usage-accumulator.ts` | Modify | Provide normalized usage/event hooks without changing activity semantics. |
| `src/main/activity-engine/session-telemetry.ts` | Modify | Expose collector snapshots and normalized signals. |
| `src/main/transition-engine/transition-engine.ts` | Modify | Capture startup context before movement and handle pre-launch failure. |
| `src/main/transition-engine/session-startup/prepare-spawn.ts` | Modify | Carry common provenance/attempt startup context. |
| `src/main/transition-engine/session-startup/auto-spawn.ts` | Modify | Pre-launch transactional insert for automatic starts. |
| `src/main/transition-engine/session-startup/resume-suspended.ts` | Modify | New attempts, snapshots, and recovery finalization. |
| `src/main/transition-engine/session-lifecycle.ts` | Modify | Pair CAS lifecycle transitions with finalizer reasons. |
| `src/main/pty/lifecycle/session-spawn-flow.ts` | Modify | Collector lifecycle and process-boundary checkpoints. |
| `src/main/pty/session-manager.ts` | Modify | Expose exact associations and final telemetry snapshots. |
| `src/main/ipc/handlers/session-reconcile.ts` | Modify | Finalize suspend/restart/reconciliation paths. |
| `src/main/ipc/handlers/sessions.ts` | Modify | Finalize suspend/reset/promote/exit paths with result mapping. |
| `src/main/ipc/handlers/task-move.ts` | Modify | Route move-related terminal branches through finalizer. |
| `src/main/ipc/handlers/project-relocate.ts` | Modify | Finalize intentional relocation stops with exact ids. |
| `src/main/ipc/handlers/auto-spawn-reconcile.ts` | Modify | Use shared startup/finalization in reconciliation. |
| `src/main/ipc/handlers/session-metrics.ts` | Modify | Retain aggregate projections under finalizer authority. |
| `src/main/ipc/handlers/metrics-snapshot-timer.ts` | Modify | Add best-effort active safe-boundary checkpoints. |
| `src/main/ipc/handlers/execution-history.ts` | Create | Project-scoped SQL history and lazy selected-slice IPC with source/FK/fingerprint/range validation. |
| `src/main/ipc/register-all.ts` | Modify | Register execution-history handlers. |
| `src/preload/preload.ts` | Modify | Expose typed history and slice methods. |
| `src/renderer/window-manager/components/TaskDetailWindow.tsx` | Modify | Add separate History state/routing. |
| `src/renderer/components/dialogs/task-detail/TaskDetailHeader.tsx` | Modify | Add distinct History control. |
| `src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx` | Modify | Render History surface without changing existing branches. |
| `src/renderer/components/dialogs/task-detail/task-detail-host.tsx` | Modify | Thread explicit project/task identity and callbacks. |
| `src/renderer/components/dialogs/task-detail/ExecutionHistoryPanel.tsx` | Create | History list, details, filters, states, and bounded transcript action. |
| `src/renderer/components/dialogs/SessionSummaryPanel.tsx` | Modify | Preserve summary and add separate History affordance. |
| `tests/unit/execution-history-repository.test.ts` | Create | Repository schema/FKs, isolation, pagination, attempts, source reservation, and idempotency coverage. |
| `tests/unit/native-slice-ownership.test.ts` | Create | Canonical identity, source generation, one-session/one-open-slice, frontier, truncation, and closed-range invariants. |
| `tests/unit/execution-finalizer.test.ts` | Create | Result/telemetry mapping, source-change closure, resilience, and finalization invariants. |
| `tests/unit/omp-session-history-parser.test.ts` | Modify | OMP ledger fields, exact fingerprints, boundaries, and bounded-slice fixtures. |
| `tests/unit/history-ipc-handler.test.ts` | Create | SQL-only history and separate source-validated slice IPC contracts. |
| `tests/ui/task-history.spec.tsx` | Create | History UI states, filters, and selected-slice rendering. |
| `tests/e2e/task-execution-history.spec.ts` | Create | End-to-end lifecycle, ownership, generation, recovery, and compatibility coverage. |

The implementation is complete only when these invariants hold across the inventory: `createExecutionStart` is the sole startup authority and all four startup families use it; no migration backfill occurs; legacy `sessions` remain in chronological/filterable history via the explicit unknown/unavailable projection; provenance never stores task/workspace/config paths; native source identity is `fs.realpath` followed by absolute `/` normalization with only Windows drive-letter lowercasing, complete-header recursively sorted compact JSON SHA-256, first `min(64 KiB,file size)` prefix SHA-256, and optional `dev:ino`; source rows are immutable generations keyed by native id/path/generation; each Kangentic session owns exactly one slice, each source has at most one open slice, reservation uses `BEGIN IMMEDIATE` and conditional frontier advancement, source replacement/shrink closes the open slice at its committed frontier with `partial` telemetry and `source_changed` rather than allocating another slice to that session, later resumed/new sessions reserve the next generation, and every closed range hash is verified before serving; history pagination uses the specified bounded keyset cursor; selected slices alone may open native files and failures return `unavailable`/`source_changed` without whole-task fallback or canonical paths in API responses; and the exact v1 privacy allowlist is the only configuration material hashed or persisted.
