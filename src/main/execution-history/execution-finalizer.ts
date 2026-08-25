import type Database from 'better-sqlite3';
import { ExecutionHistoryRepository } from '../db/repositories/execution-history-repository';
import type { ExecutionResult, TelemetryStatus } from '../../shared/types';

export type FinalizationReason = 'success' | 'failure' | 'suspend' | 'cancel' | 'interrupt' | 'crash';

export interface FinalizationInput {
  sessionRecordId: string;
  reason: FinalizationReason;
  exitCode?: number | null;
  telemetryStatus?: TelemetryStatus;
  closure?: { endByte: number; endOrdinal: number; rangeHash: string | null; state?: 'closed' | 'partial' };
}
function resultFor(input: FinalizationInput): ExecutionResult {
  if (input.reason === 'success' || input.exitCode === 0) return 'succeeded';
  if (input.reason === 'failure' || (input.exitCode !== null && input.exitCode !== undefined && input.exitCode !== 0)) return 'failed';
  if (input.reason === 'suspend') return 'suspended';
  if (input.reason === 'cancel') return 'cancelled';
  return 'interrupted';
}

/** Best-effort, retryable finalizer. It never propagates into PTY/workflow paths. */
export function finalizeExecution(db: Database.Database, input: FinalizationInput): boolean {
  try {
    const repo = new ExecutionHistoryRepository(db);
    return repo.finalize(input.sessionRecordId, input.reason, resultFor(input), input.telemetryStatus ?? 'complete', undefined, input.closure);
  } catch (error) {
    console.warn('[execution-history] finalization deferred', input.sessionRecordId, error instanceof Error ? error.message : String(error));
    return false;
  }
}
