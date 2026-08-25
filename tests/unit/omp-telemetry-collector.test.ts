import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { Activity, EventType } from '../../src/shared/types';
import { buildExecutionProvenance, canonicalizeProvenance } from '../../src/main/execution-history/provenance';
import { OmpTelemetryCollector } from '../../src/main/execution-history/omp-telemetry-collector';
import {
  captureOmpSessionFromFilesystem,
  ompSessionDirectory,
  parseOmpHeader,
  parseOmpSessionHistory,
} from '../../src/main/agent/adapters/omp/session-history-parser';

describe('OMP execution telemetry normalization', () => {
  it('retains provider/model buckets, explicit zeroes, cache buckets, timing and signals', () => {
    const result = parseOmpSessionHistory([
      JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'run' } }),
      JSON.stringify({ type: 'message', timestamp: 100, message: { role: 'assistant', model: 'omp/model-a', usage: { inputTokens: 12, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 4, contextWindowSize: 100 }, content: [{ toolCall: { id: 'call-1', name: 'read_file' } }] } }),
      JSON.stringify({ type: 'message', timestamp: 200, message: { role: 'toolResult', toolCallId: 'call-1', content: 'ok' } }),
      JSON.stringify({ type: 'message', timestamp: 300, message: { role: 'assistant', model: 'omp/model-b', usage: { input: 20, output: 5 }, content: 'done' } }),
      '{malformed',
    ].join('\n'), 'full');
    expect(result.usage).toMatchObject({ contextWindow: { usedTokens: 20, totalInputTokens: 20, totalOutputTokens: 5, cacheTokens: 7, contextWindowSize: 100 }, model: { id: 'omp/model-b' } });
    expect(result.events).toEqual([
      expect.objectContaining({ type: EventType.ToolStart, tool: 'read_file', toolId: 'call-1', ts: 100 }),
      expect.objectContaining({ type: EventType.ToolEnd, toolId: 'call-1', ts: 200 }),
    ]);
    expect(result.activity).toBe(Activity.Idle);
  });

  it('does not fabricate usage for malformed or metadata-only records', () => {
    const result = parseOmpSessionHistory([JSON.stringify({ type: 'session', version: 3, id: 'native-1', cwd: '/project' }), JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'no usage' }] } }), 'not json'].join('\n'), 'append');
    expect(result.usage).toBeNull();
    expect(result.events).toEqual([]);
  });

  it('parses padded headers but rejects wrong versions and missing identity', () => {
    expect(parseOmpHeader('prefix {"type":"session","version":3,"id":"native","cwd":"/p"} suffix')).toEqual({ type: 'session', version: 3, id: 'native', cwd: '/p', timestamp: undefined, title: undefined });
    expect(parseOmpHeader(JSON.stringify({ type: 'session', version: 2, id: 'native', cwd: '/p' }))).toBeNull();
    expect(parseOmpHeader(JSON.stringify({ type: 'session', version: 3, cwd: '/p' }))).toBeNull();
  });

  it('captures exactly one newly-created session and fails closed on ambiguity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-history-root-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-history-cwd-'));
    const directory = ompSessionDirectory(cwd, root);
    fs.mkdirSync(directory, { recursive: true });
    const launch = new Date();
    fs.writeFileSync(path.join(directory, 'native-one.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'native-one', cwd, timestamp: launch.toISOString() }) + '\n');
    await expect(captureOmpSessionFromFilesystem({ cwd, spawnedAt: launch, launchStartedAt: launch, rolloutRoot: root, timeoutMs: 1, maxAttempts: 1 })).resolves.toBe('native-one');
    fs.writeFileSync(path.join(directory, 'native-two.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'native-two', cwd, timestamp: launch.toISOString() }) + '\n');
    await expect(captureOmpSessionFromFilesystem({ cwd, spawnedAt: launch, launchStartedAt: launch, rolloutRoot: root, timeoutMs: 1, maxAttempts: 1 })).resolves.toBeNull();
  });

  it('persists each normalized event through the durable collector boundary', () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db = { prepare: vi.fn((sql: string) => ({ get: () => undefined, run: (...args: unknown[]) => { calls.push({ sql, args }); return { changes: 1 }; } })) } as unknown as Database.Database;
    new OmpTelemetryCollector(db, 'session-1', 'slice-1').collect([
      { ordinal: 4, usage: { provider: 'omp', model: 'model-a', inputTokens: 1, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, assistantObservedAt: 100, observationAt: 110 } },
      { ordinal: 5, signal: { eventOrdinal: 5, type: 'tool_error', toolCallId: 'call-1', toolName: 'read_file', isError: true, occurredAt: 120 } },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain('slice-1');
    expect(calls[1].sql).toMatch(/execution_signals/i);
    expect(calls[1].args).toContain('tool_error');
  });

  it('does not throw when both collection and diagnostic persistence fail', () => {
    const db = { prepare: vi.fn(() => { throw new Error('database closed'); }) } as unknown as Database.Database;
    expect(() => new OmpTelemetryCollector(db, 'session-1', 'slice-1').collect([{ ordinal: 1, usage: { provider: null, model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, assistantObservedAt: null, observationAt: null } }])).not.toThrow();
  });
});

describe('execution provenance privacy and immutability', () => {
  it('captures only allowlisted effective configuration and hashes its canonical form', () => {
    const input = { boardProfileId: 'profile-a', stage: { id: 'stage-1', name: 'Implement', role: 'todo' }, effective: { agentId: 'omp', sessionType: 'omp_agent', model: 'model-a', effort: 'high', permissionMode: 'default', autoSpawn: true, sessionTarget: 'main', spawnStrategy: 'create_or_resume' } } as const;
    const provenance = buildExecutionProvenance(input, 3);
    expect(provenance).toMatchObject({ stageId: 'stage-1', stageName: 'Implement', stageAttempt: 3, agentId: 'omp', configHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(provenance)).not.toMatch(/prompt|cwd|environment|secret|api[_-]?key/i);
    expect(canonicalizeProvenance(input)).not.toMatch(/prompt|cwd|environment|secret|api[_-]?key/i);
    expect(buildExecutionProvenance({ ...input, stage: { ...input.stage, name: 'Review' } }, 3).configHash).not.toBe(provenance.configHash);
  });
});
