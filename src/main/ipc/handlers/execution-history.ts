import fs from 'node:fs';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { ExecutionDiagnostic, ExecutionHistoryRequest, ExecutionSliceTranscriptRequest, ExecutionSliceTranscriptResponse } from '../../../shared/types';
import { getProjectDb } from '../../db/database';
import { ExecutionHistoryRepository } from '../../db/repositories/execution-history-repository';
import { hashRange, sourceEvidence } from '../../execution-history/native-slice-ownership';
import { parseOmpTranscriptWindow } from '../../agent/adapters/omp/transcript-parser';
import type { IpcContext } from '../ipc-context';

function diagnostic(code: string, message: string): ExecutionDiagnostic {
  return {
    diagnosticKey: `slice:${code}`,
    severity: 'warning',
    code,
    message,
    boundaryByte: null,
    boundaryOrdinal: null,
  };
}

export function registerExecutionHistoryHandlers(_context: IpcContext): void {
  ipcMain.handle(IPC.EXECUTION_HISTORY_GET, (_event, request: ExecutionHistoryRequest) => {
    if (!request?.projectId || !request.taskId) return { items: [], nextCursor: null };
    return new ExecutionHistoryRepository(getProjectDb(request.projectId)).list(request);
  });
  ipcMain.handle(IPC.EXECUTION_SLICE_TRANSCRIPT_GET, async (_event, request: ExecutionSliceTranscriptRequest): Promise<ExecutionSliceTranscriptResponse> => {
    if (!request?.projectId || !request.sessionId) {
      return { state: 'unavailable', message: 'Missing project or execution identity', diagnostics: [diagnostic('invalid_request', 'Missing project or execution identity')] };
    }
    const db = getProjectDb(request.projectId);
    const row = db.prepare(`
      SELECT x.*,s.native_session_id,n.canonical_path,n.canonical_header_hash,n.prefix_hash,
             n.filesystem_identity,n.durable_frontier,n.durable_frontier_hash
        FROM execution_slices x
        JOIN sessions s ON s.id=x.session_id
        JOIN native_execution_sources n ON n.id=x.source_id
       WHERE x.session_id=?
    `).get(request.sessionId) as Record<string, unknown> | undefined;
    if (!row) {
      return { state: 'unavailable', message: 'No persisted transcript slice is available', diagnostics: [diagnostic('missing_slice', 'No persisted transcript slice is available')] };
    }
    const filePath = String(row.canonical_path);
    const evidence = sourceEvidence(filePath, String(row.native_session_id));
    if (!evidence) {
      return { state: 'unavailable', message: 'Native source is unavailable or malformed', diagnostics: [diagnostic('source_unavailable', 'Native source is unavailable or malformed')] };
    }
    if (
      evidence.canonicalPath !== filePath
      || evidence.canonicalHeaderHash !== row.canonical_header_hash
      || evidence.prefixHash !== row.prefix_hash
      || (row.filesystem_identity !== null && evidence.filesystemIdentity !== row.filesystem_identity)
    ) {
      return { state: 'source_changed', message: 'Native source identity changed', diagnostics: [diagnostic('source_changed', 'Native source identity or fingerprint changed')] };
    }
    const stat = fs.statSync(filePath);
    const durableFrontier = Number(row.durable_frontier);
    if (stat.size < durableFrontier) {
      return { state: 'source_changed', message: 'Native source is shorter than its durable frontier', diagnostics: [diagnostic('source_changed', 'Native source is shorter than its durable frontier')] };
    }
    if (row.filesystem_identity === null && row.durable_frontier_hash) {
      const durableHash = hashRange(filePath, 0, durableFrontier);
      if (!durableHash || durableHash !== row.durable_frontier_hash) {
        return { state: 'source_changed', message: 'Durable source prefix changed', diagnostics: [diagnostic('source_changed', 'Durable source prefix changed')] };
      }
    }
    const start = Number(row.start_byte);
    const end = row.state === 'open'
      ? durableFrontier
      : Number(row.end_byte);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end > stat.size || end - start > 1024 * 1024) {
      return { state: 'source_changed', message: 'Persisted transcript boundary is no longer valid', diagnostics: [diagnostic('boundary_invalid', 'Persisted transcript boundary is no longer valid')] };
    }
    if (row.state === 'closed') {
      if (typeof row.closed_range_hash !== 'string' || !row.closed_range_hash) {
        return { state: 'unavailable', message: 'Closed transcript range has no integrity hash', diagnostics: [diagnostic('range_hash_missing', 'Closed transcript range has no integrity hash')] };
      }
      const rangeHash = hashRange(filePath, start, end);
      if (!rangeHash || rangeHash !== row.closed_range_hash) {
        return { state: 'source_changed', message: 'Persisted transcript slice changed', diagnostics: [diagnostic('range_changed', 'Persisted transcript slice changed')] };
      }
    }
    try {
      const parsed = await parseOmpTranscriptWindow(filePath, start, end - start);
      return { state: row.state === 'open' ? 'partial' : 'ok', entries: parsed.entries };
    } catch {
      return { state: 'unavailable', message: 'Native transcript could not be parsed', diagnostics: [diagnostic('parse_failed', 'Native transcript could not be parsed')] };
    }
  });
}
