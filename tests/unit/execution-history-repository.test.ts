import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ExecutionHistoryRepository } from '../../src/main/db/repositories/execution-history-repository';

function mockDb() {
  const statements: string[] = [];
  const db = { prepare: vi.fn((sql: string) => { statements.push(sql); return { run: vi.fn(() => ({ changes: 1 })), get: vi.fn(() => undefined), all: vi.fn(() => []) }; }) } as unknown as Database.Database;
  return { db, statements };
}
describe('ExecutionHistoryRepository', () => {
  it('uses a left-join history read model with explicit legacy projections', () => {
    const { db, statements } = mockDb();
    new ExecutionHistoryRepository(db).list({ projectId: 'p1', taskId: 't1', limit: 50 });
    expect(statements[0]).toMatch(/LEFT JOIN session_execution_history/i);
    expect(statements[0]).toMatch(/COALESCE\(h\.execution_result,'unknown'\)/i);
  });
  it('upserts normalized detail rows by slice and ordinal', () => {
    const { db, statements } = mockDb();
    const repo = new ExecutionHistoryRepository(db);
    repo.upsertUsage('slice', { provider: null, model: 'm', inputTokens: null, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, assistantObservedAt: null, observationAt: null }, 2);
    repo.upsertSignal('slice', { eventOrdinal: 2, type: 'assistant_turn', toolCallId: null, toolName: null, isError: null, occurredAt: null });
    expect(statements.join('\n')).toMatch(/ON CONFLICT\(slice_id,event_ordinal\)/i);
  });

  it('uses immediate transactions and conditional frontier updates', () => {
    const statements: string[] = [];
    const db = {
      transaction: vi.fn((fn: () => unknown) => ({ immediate: fn })),
      prepare: vi.fn((sql: string) => {
        statements.push(sql);
        return {
          get: vi.fn(() => ({ source_id: 'source' })),
          run: vi.fn(() => ({ changes: 1 })),
          all: vi.fn(() => []),
        };
      }),
    } as unknown as Database.Database;
    expect(new ExecutionHistoryRepository(db).checkpointSlice('slice', 4, 8, 2, 'hash')).toBe(true);
    expect(db.transaction).toHaveBeenCalled();
    expect(statements.join('\n')).toMatch(/WHERE id=\? AND durable_frontier=\?/i);
  });
});
