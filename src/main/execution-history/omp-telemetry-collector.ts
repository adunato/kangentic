import type Database from 'better-sqlite3';
import { ExecutionHistoryRepository } from '../db/repositories/execution-history-repository';
import type { ExecutionSignal, ExecutionUsageBreakdown } from '../../shared/types';

export interface NormalizedTelemetryEvent { ordinal: number; usage?: ExecutionUsageBreakdown; signal?: ExecutionSignal }

/** Persists normalized events for one exact durable slice; callers may checkpoint separately. */
export class OmpTelemetryCollector {
  private readonly repository: ExecutionHistoryRepository;
  constructor(db: Database.Database, private readonly sessionId: string, private readonly sliceId: string) { this.repository = new ExecutionHistoryRepository(db); }
  collect(events: readonly NormalizedTelemetryEvent[]): void {
    try {
      for (const event of events) {
        if (event.usage) this.repository.upsertUsage(this.sliceId, event.usage, event.ordinal);
        if (event.signal) this.repository.upsertSignal(this.sliceId, event.signal);
      }
    } catch (error) {
      try {
        this.repository.upsertDiagnostic(this.sessionId, { diagnosticKey: 'collector:error', severity: 'error', code: 'collector_error', message: error instanceof Error ? error.message : 'Telemetry collection failed', boundaryByte: null, boundaryOrdinal: null }, this.sliceId);
      } catch {
        // A failed database must not escape the lifecycle path, including while recording its own diagnostic.
      }
    }
  }
}
