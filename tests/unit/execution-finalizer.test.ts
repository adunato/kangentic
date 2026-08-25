import { describe, expect, it } from 'vitest';
import { finalizeExecution } from '../../src/main/execution-history/execution-finalizer';

describe('execution finalizer', () => {
  it('isolates database failure and remains non-throwing', () => {
    const db = { prepare: () => { throw new Error('closed'); } } as never;
    expect(finalizeExecution(db, { sessionRecordId: 's', reason: 'failure', exitCode: 1 })).toBe(false);
  });
  it('accepts explicit exact session identity and separate telemetry status', () => {
    const calls: unknown[][] = [];
    const db = { transaction: (fn: () => unknown) => ({ immediate: fn }), prepare: () => ({ get: () => undefined, run: (...args: unknown[]) => { calls.push(args); return { changes: 1 }; } }) } as never;
    expect(finalizeExecution(db, { sessionRecordId: 's', reason: 'success', exitCode: 0, telemetryStatus: 'partial' })).toBe(true);
    expect(calls.some((args) => args.includes('succeeded') && args.includes('partial'))).toBe(true);
  });

  it('maps cancel and recovery independently from telemetry state', () => {
    const calls: unknown[][] = [];
    const db = {
      transaction: (fn: () => unknown) => ({ immediate: fn }),
      prepare: () => ({
        get: () => undefined,
        run: (...args: unknown[]) => { calls.push(args); return { changes: 1 }; },
      }),
    } as never;
    expect(finalizeExecution(db, {
      sessionRecordId: 'cancelled-session',
      reason: 'cancel',
      telemetryStatus: 'failed',
      closure: { endByte: 12, endOrdinal: 4, rangeHash: 'hash', state: 'partial' },
    })).toBe(true);
    expect(calls.some((args) => args.includes('cancelled') && args.includes('failed'))).toBe(true);
    expect(calls.some((args) => args.includes('hash') && args.includes('partial'))).toBe(true);
  });
});
