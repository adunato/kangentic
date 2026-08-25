import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ExecutionDiagnostic, ExecutionHistoryDetail, ExecutionHistoryRequest,
  ExecutionHistoryResponse, ExecutionProvenance, ExecutionResult, ExecutionSignal,
  ExecutionUsageBreakdown, TelemetryStatus,
} from '../../../shared/types';

export interface HistoryStartInput { sessionId: string; taskId: string; startedAt: string; provenance: ExecutionProvenance }
export interface SourceEvidence {
  nativeSessionId: string; canonicalPath: string; canonicalHeaderHash: string; prefixHash: string;
  filesystemIdentity?: string | null; observedSize?: number; durableFrontier?: number;
  durableFrontierOrdinal?: number; durableFrontierHash?: string | null;
}
export interface SliceReservation { sessionId: string; nativeSessionId: string; source: SourceEvidence; startByte?: number; startOrdinal?: number }
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function encodeCursor(value: { startedAt: string; sessionId: string }): string { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
function decodeCursor(value: string | null | undefined): { startedAt: string; sessionId: string } | null {
  if (!value) return null;
  try { const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>; return typeof parsed.startedAt === 'string' && typeof parsed.sessionId === 'string' ? { startedAt: parsed.startedAt, sessionId: parsed.sessionId } : null; } catch { return null; }
}

export class ExecutionHistoryRepository {
  constructor(private readonly db: Database.Database) {}
  /** Transaction participant only. The caller owns BEGIN IMMEDIATE and attempts. */
  insertStartInTransaction(tx: Database.Database, input: HistoryStartInput): void {
    const p = input.provenance; const timestamp = now();
    tx.prepare(`INSERT INTO session_execution_history
      (session_id,task_id,stage_id,stage_name,stage_role,stage_attempt,board_profile_id,agent_id,session_type,model,effort,permission_mode,config_hash,execution_result,telemetry_status,started_at,created_at,updated_at)
      SELECT ?,task_id,?,?,?,?,?,?,?,?,?,?,?,'in_progress','pending',?,?,? FROM sessions WHERE id=?`)
      .run(input.sessionId, p.stageId, p.stageName, p.stageRole, p.stageAttempt, p.boardProfileId, p.agentId, p.sessionType, p.model, p.effort, p.permissionMode, p.configHash, input.startedAt, timestamp, timestamp, input.sessionId);
  }
  getBySessionId(sessionId: string): ExecutionHistoryDetail | null {
    const row = this.db.prepare('SELECT * FROM session_execution_history WHERE session_id=?').get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.getDetail(sessionId) : null;
  }
  list(request: ExecutionHistoryRequest): ExecutionHistoryResponse {
    const limit = Math.max(1, Math.min(100, request.limit ?? 50)); const filter = request.filter ?? {}; const cursor = decodeCursor(request.cursor);
    const where = ['s.task_id=?']; const params: unknown[] = [request.taskId];
    if (filter.stageId !== undefined) { where.push('h.stage_id IS ?'); params.push(filter.stageId); }
    if (filter.executionResult) { where.push("COALESCE(h.execution_result,'unknown')=?"); params.push(filter.executionResult); }
    if (filter.telemetryStatus) { where.push("COALESCE(h.telemetry_status,'unavailable')=?"); params.push(filter.telemetryStatus); }
    if (cursor) { where.push('(s.started_at<? OR (s.started_at=? AND s.id<?))'); params.push(cursor.startedAt, cursor.startedAt, cursor.sessionId); }
    const rows = this.db.prepare(`SELECT s.*,h.stage_id,h.stage_name,h.stage_role,h.stage_attempt,h.board_profile_id,h.agent_id AS history_agent_id,h.model AS history_model,h.effort,h.permission_mode AS history_permission_mode,h.config_hash,COALESCE(h.execution_result,'unknown') AS execution_result,COALESCE(h.telemetry_status,'unavailable') AS telemetry_status,h.finished_at FROM sessions s LEFT JOIN session_execution_history h ON h.session_id=s.id WHERE ${where.join(' AND ')} ORDER BY s.started_at DESC,s.id DESC LIMIT ?`).all(...params, limit + 1) as Array<Record<string, unknown>>;
    const selected = rows.slice(0, limit);
    return { items: selected.map((row) => this.summary(row)), nextCursor: rows.length > limit && selected.length ? encodeCursor({ startedAt: String(selected[selected.length - 1].started_at), sessionId: String(selected[selected.length - 1].id) }) : null };
  }
  reserveSlice(input: SliceReservation): { sliceId: string; sourceId: string; startByte: number; startOrdinal: number } {
    const transaction = this.db.transaction(() => {
      const evidence = input.source;
      const latest = this.db.prepare(
        'SELECT * FROM native_execution_sources WHERE native_session_id=? AND canonical_path=? ORDER BY generation DESC LIMIT 1',
      ).get(input.nativeSessionId, evidence.canonicalPath) as Record<string, unknown> | undefined;
      const changed = latest !== undefined && (
        latest.canonical_header_hash !== evidence.canonicalHeaderHash
        || latest.prefix_hash !== evidence.prefixHash
        || (latest.filesystem_identity !== null
          && evidence.filesystemIdentity !== null
          && latest.filesystem_identity !== evidence.filesystemIdentity)
        || (latest.filesystem_identity === null
          && Number(evidence.durableFrontier ?? 0) > 0
          && evidence.durableFrontierHash !== undefined
          && evidence.durableFrontierHash !== latest.durable_frontier_hash)
      );
      let sourceId: string;
      let source: Record<string, unknown>;
      if (!latest || changed) {
        sourceId = uuid();
        const generation = latest ? Number(latest.generation) + 1 : 0;
        const timestamp = now();
        this.db.prepare(`
          INSERT INTO native_execution_sources
            (id,native_session_id,canonical_path,canonical_header_hash,prefix_hash,
             filesystem_identity,generation,durable_frontier,durable_frontier_ordinal,
             durable_frontier_hash,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,0,0,?,?,?)
        `).run(
          sourceId, input.nativeSessionId, evidence.canonicalPath,
          evidence.canonicalHeaderHash, evidence.prefixHash,
          evidence.filesystemIdentity ?? null, generation,
          evidence.durableFrontierHash ?? null, timestamp, timestamp,
        );
        source = this.db.prepare('SELECT * FROM native_execution_sources WHERE id=?').get(sourceId) as Record<string, unknown>;
      } else {
        sourceId = String(latest.id);
        source = latest;
      }
      const existing = this.db.prepare(
        'SELECT id,source_id,start_byte,start_ordinal FROM execution_slices WHERE session_id=?',
      ).get(input.sessionId) as Record<string, unknown> | undefined;
      if (existing) {
        return {
          sliceId: String(existing.id),
          sourceId: String(existing.source_id),
          startByte: Number(existing.start_byte),
          startOrdinal: Number(existing.start_ordinal),
        };
      }
      const startByte = input.startByte ?? Number(source.durable_frontier ?? 0);
      const startOrdinal = input.startOrdinal ?? Number(source.durable_frontier_ordinal ?? 0);
      const sliceId = uuid();
      this.db.prepare(`
        INSERT INTO execution_slices
          (id,session_id,source_id,start_byte,start_ordinal,state,created_at,updated_at)
        VALUES (?,?,?,?,?,'open',?,?)
      `).run(sliceId, input.sessionId, sourceId, startByte, startOrdinal, now(), now());
      return { sliceId, sourceId, startByte, startOrdinal };
    });
    return transaction.immediate() as { sliceId: string; sourceId: string; startByte: number; startOrdinal: number };
  }

  checkpointSlice(sliceId: string, expectedFrontier: number, endByte: number, endOrdinal: number, frontierHash: string): boolean {
    const transaction = this.db.transaction(() => {
      const slice = this.db.prepare(
        "SELECT source_id FROM execution_slices WHERE id=? AND state='open'",
      ).get(sliceId) as { source_id: string } | undefined;
      if (!slice) return false;
      const changed = this.db.prepare(`
        UPDATE native_execution_sources
           SET durable_frontier=?,durable_frontier_ordinal=?,durable_frontier_hash=?,updated_at=?
         WHERE id=? AND durable_frontier=?
      `).run(endByte, endOrdinal, frontierHash, now(), slice.source_id, expectedFrontier);
      return changed.changes > 0;
    });
    return transaction.immediate() as boolean;
  }
  checkpointSliceRetry(
    sliceId: string,
    expectedFrontier: number,
    endByte: number,
    endOrdinal: number,
    frontierHash: string,
    maxAttempts = 3,
  ): boolean {
    let expected = expectedFrontier;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (this.checkpointSlice(sliceId, expected, endByte, endOrdinal, frontierHash)) return true;
      const row = this.db.prepare(`
        SELECT n.durable_frontier
          FROM execution_slices x
          JOIN native_execution_sources n ON n.id=x.source_id
         WHERE x.id=? AND x.state='open'
      `).get(sliceId) as { durable_frontier: number } | undefined;
      if (!row || Number(row.durable_frontier) > endByte) return false;
      expected = Number(row.durable_frontier);
    }
    return false;
  }

  updateTelemetryStatus(sessionId: string, status: TelemetryStatus): void {
    this.db.prepare(
      'UPDATE session_execution_history SET telemetry_status=?,updated_at=? WHERE session_id=?',
    ).run(status, now(), sessionId);
  }
  closeSlice(sliceId: string, endByte: number, endOrdinal: number, rangeHash: string | null, state: 'closed' | 'partial' = 'closed'): void {
    this.db.prepare(`
      UPDATE execution_slices
         SET end_byte=?,end_ordinal=?,closed_range_hash=?,state=?,updated_at=?
       WHERE id=? AND state='open'
    `).run(endByte, endOrdinal, rangeHash, state, now(), sliceId);
  }

  upsertUsage(sliceId: string, usage: ExecutionUsageBreakdown, eventOrdinal: number): void {
    this.db.prepare(`
      INSERT INTO execution_model_usage
        (id,slice_id,event_ordinal,provider,model,input_tokens,output_tokens,
         cache_read_tokens,cache_write_tokens,cost_usd,assistant_observed_at,observation_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(slice_id,event_ordinal) DO UPDATE SET
        provider=excluded.provider,model=excluded.model,input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,cache_read_tokens=excluded.cache_read_tokens,
        cache_write_tokens=excluded.cache_write_tokens,cost_usd=excluded.cost_usd,
        assistant_observed_at=excluded.assistant_observed_at,observation_at=excluded.observation_at
    `).run(
      uuid(), sliceId, eventOrdinal, usage.provider, usage.model, usage.inputTokens,
      usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.costUsd,
      usage.assistantObservedAt, usage.observationAt,
    );
    this.reconcileAggregates(sliceId);
  }

  upsertSignal(sliceId: string, signal: ExecutionSignal): void {
    this.db.prepare(`
      INSERT INTO execution_signals
        (id,slice_id,event_ordinal,type,tool_call_id,tool_name,is_error,occurred_at,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(slice_id,event_ordinal) DO UPDATE SET
        type=excluded.type,tool_call_id=excluded.tool_call_id,tool_name=excluded.tool_name,
        is_error=excluded.is_error,occurred_at=excluded.occurred_at,metadata_json=excluded.metadata_json
    `).run(
      uuid(), sliceId, signal.eventOrdinal, signal.type, signal.toolCallId, signal.toolName,
      signal.isError === null ? null : signal.isError ? 1 : 0, signal.occurredAt,
      signal.metadata ? JSON.stringify(signal.metadata) : null,
    );
  }

  upsertDiagnostic(sessionId: string, diagnostic: ExecutionDiagnostic, sliceId?: string | null): void {
    this.db.prepare(`
      INSERT INTO execution_telemetry_diagnostics
        (id,session_id,slice_id,diagnostic_key,severity,code,message,boundary_byte,boundary_ordinal,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id,diagnostic_key) DO UPDATE SET
        slice_id=excluded.slice_id,severity=excluded.severity,code=excluded.code,
        message=excluded.message,boundary_byte=excluded.boundary_byte,boundary_ordinal=excluded.boundary_ordinal
    `).run(
      uuid(), sessionId, sliceId ?? null, diagnostic.diagnosticKey, diagnostic.severity,
      diagnostic.code, diagnostic.message.slice(0, 1000), diagnostic.boundaryByte,
      diagnostic.boundaryOrdinal, now(),
    );
  }

  finalize(
    sessionId: string,
    reason: string,
    result: ExecutionResult,
    telemetryStatus: TelemetryStatus,
    finishedAt = now(),
    closure?: { endByte: number; endOrdinal: number; rangeHash: string | null; state?: 'closed' | 'partial' },
  ): boolean {
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT 1 FROM execution_finalizations WHERE session_id=?').get(sessionId);
      if (existing) return false;
      this.db.prepare(`
        INSERT INTO execution_finalizations
          (session_id,finalization_key,reason,result,telemetry_status,finished_at)
        VALUES (?,?,?,?,?,?)
      `).run(sessionId, sessionId, reason, result, telemetryStatus, finishedAt);
      this.db.prepare(`
        UPDATE session_execution_history
           SET execution_result=?,telemetry_status=?,finished_at=?,updated_at=?
         WHERE session_id=?
      `).run(result, telemetryStatus, finishedAt, finishedAt, sessionId);
      if (closure) {
        this.db.prepare(`
          UPDATE execution_slices
             SET end_byte=?,end_ordinal=?,closed_range_hash=?,state=?,updated_at=?
           WHERE session_id=? AND state='open'
        `).run(
          closure.endByte, closure.endOrdinal, closure.rangeHash,
          closure.state ?? 'closed', finishedAt, sessionId,
        );
      }
      return true;
    });
    return transaction.immediate() as boolean;
  }

  private reconcileAggregates(sliceId: string): void {
    const row = this.db.prepare(`
      SELECT x.session_id,
             SUM(u.input_tokens) AS input_tokens,
             SUM(u.output_tokens) AS output_tokens,
             SUM(u.cost_usd) AS cost_usd,
             MAX(u.model) AS model_id,
             COUNT(u.input_tokens) AS input_count,
             COUNT(u.output_tokens) AS output_count,
             COUNT(u.cost_usd) AS cost_count
        FROM execution_slices x
        LEFT JOIN execution_model_usage u ON u.slice_id=x.id
       WHERE x.id=?
    `).get(sliceId) as Record<string, unknown> | undefined;
    if (!row) return;
    this.db.prepare(`
      UPDATE sessions SET
        total_input_tokens=CASE WHEN ? > 0 THEN ? ELSE total_input_tokens END,
        total_output_tokens=CASE WHEN ? > 0 THEN ? ELSE total_output_tokens END,
        total_cost_usd=CASE WHEN ? > 0 THEN ? ELSE total_cost_usd END,
        model_id=COALESCE(?,model_id)
      WHERE id=?
    `).run(
      Number(row.input_count), row.input_tokens,
      Number(row.output_count), row.output_tokens,
      Number(row.cost_count), row.cost_usd,
      row.model_id, row.session_id,
    );
  }
  private summary(row: Record<string, unknown>): ExecutionHistoryDetail {
    const legacy = row.stage_id === null || row.stage_id === undefined; const stage = { id: legacy ? null : String(row.stage_id), name: legacy ? null : String(row.stage_name ?? ''), role: legacy ? null : String(row.stage_role ?? ''), attempt: legacy ? null : Number(row.stage_attempt) };
    const summary = { sessionId:String(row.id),taskId:String(row.task_id),startedAt:String(row.started_at),finishedAt:row.finished_at ? String(row.finished_at) : row.exited_at ? String(row.exited_at) : null,status:String(row.status) as ExecutionHistoryDetail['status'],exitCode:row.exit_code == null ? null : Number(row.exit_code),stage,executionResult:(legacy ? 'unknown' : String(row.execution_result ?? 'unknown')) as ExecutionResult,telemetryStatus:(legacy ? 'unavailable' : String(row.telemetry_status ?? 'pending')) as TelemetryStatus,isLegacy:legacy,model:row.history_model ? String(row.history_model) : row.model_id ? String(row.model_id) : null,provider:null,inputTokens:row.total_input_tokens == null ? null : Number(row.total_input_tokens),outputTokens:row.total_output_tokens == null ? null : Number(row.total_output_tokens),costUsd:row.total_cost_usd == null ? null : Number(row.total_cost_usd)};
    return { ...summary, provenance:{stageId:stage.id,stageName:stage.name,stageRole:stage.role,stageAttempt:stage.attempt ?? 0,boardProfileId:row.board_profile_id ? String(row.board_profile_id) : null,agentId:row.history_agent_id ? String(row.history_agent_id) : null,sessionType:String(row.session_type),model:summary.model,effort:row.effort ? String(row.effort) : null,permissionMode:row.history_permission_mode ? String(row.history_permission_mode) : null,configHash:row.config_hash ? String(row.config_hash) : null},usage:this.usage(String(row.id)),signals:this.signals(String(row.id)),diagnostics:this.diagnostics(String(row.id))};
  }
  private getDetail(sessionId: string): ExecutionHistoryDetail { return this.summary(this.db.prepare(`SELECT s.*,h.stage_id,h.stage_name,h.stage_role,h.stage_attempt,h.board_profile_id,h.agent_id AS history_agent_id,h.model AS history_model,h.effort,h.permission_mode AS history_permission_mode,h.config_hash,COALESCE(h.execution_result,'unknown') AS execution_result,COALESCE(h.telemetry_status,'unavailable') AS telemetry_status,h.finished_at FROM sessions s LEFT JOIN session_execution_history h ON h.session_id=s.id WHERE s.id=?`).get(sessionId) as Record<string, unknown>); }
  private usage(sessionId: string): ExecutionUsageBreakdown[] { return this.db.prepare('SELECT u.provider,u.model,u.input_tokens AS inputTokens,u.output_tokens AS outputTokens,u.cache_read_tokens AS cacheReadTokens,u.cache_write_tokens AS cacheWriteTokens,u.cost_usd AS costUsd,u.assistant_observed_at AS assistantObservedAt,u.observation_at AS observationAt FROM execution_model_usage u JOIN execution_slices x ON x.id=u.slice_id WHERE x.session_id=? ORDER BY u.event_ordinal').all(sessionId) as ExecutionUsageBreakdown[]; }
  private signals(sessionId: string): ExecutionSignal[] { return (this.db.prepare('SELECT e.event_ordinal AS eventOrdinal,e.type,e.tool_call_id AS toolCallId,e.tool_name AS toolName,e.is_error AS isError,e.occurred_at AS occurredAt,e.metadata_json AS metadataJson FROM execution_signals e JOIN execution_slices x ON x.id=e.slice_id WHERE x.session_id=? ORDER BY e.event_ordinal').all(sessionId) as Array<ExecutionSignal & { metadataJson:string|null; isError:number|null }>).map((s) => ({...s,isError:s.isError === null ? null : Boolean(s.isError),metadata:s.metadataJson ? JSON.parse(s.metadataJson) as Record<string,unknown> : undefined})); }
  private diagnostics(sessionId: string): ExecutionDiagnostic[] { return this.db.prepare('SELECT diagnostic_key AS diagnosticKey,severity,code,message,boundary_byte AS boundaryByte,boundary_ordinal AS boundaryOrdinal FROM execution_telemetry_diagnostics WHERE session_id=? ORDER BY created_at').all(sessionId) as ExecutionDiagnostic[]; }
}
