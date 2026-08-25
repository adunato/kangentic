import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import { sourceEvidence, hashRange } from '../../src/main/execution-history/native-slice-ownership';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getProjectDb: vi.fn(),
  list: vi.fn(),
}));

vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: mocks.getProjectDb }));
vi.mock('../../src/main/db/repositories/execution-history-repository', () => ({
  ExecutionHistoryRepository: class { list = mocks.list; },
}));

import { registerExecutionHistoryHandlers } from '../../src/main/ipc/handlers/execution-history';

describe('execution history IPC boundaries', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.getProjectDb.mockReset();
    mocks.list.mockReset();
    registerExecutionHistoryHandlers({} as never);
  });

  it('uses only the requested project database for initial history and forwards pagination/filtering', () => {
    const response = { items: [], nextCursor: 'next' };
    mocks.list.mockReturnValue(response);
    const db = { prepare: vi.fn() };
    mocks.getProjectDb.mockReturnValue(db);
    const request = { projectId: 'project-a', taskId: 'task-a', limit: 2, cursor: 'cursor', filter: { executionResult: 'failed' as const } };
    const result = mocks.handlers.get(IPC.EXECUTION_HISTORY_GET)!({}, request);
    expect(result).toBe(response);
    expect(mocks.getProjectDb).toHaveBeenCalledWith('project-a');
    expect(mocks.list).toHaveBeenCalledWith(request);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('does not fall back to whole-task transcript when the selected slice is absent', async () => {
    const prepare = vi.fn(() => ({ get: vi.fn(() => undefined) }));
    mocks.getProjectDb.mockReturnValue({ prepare });
    const result = await mocks.handlers.get(IPC.EXECUTION_SLICE_TRANSCRIPT_GET)!({}, { projectId: 'project-a', sessionId: 'missing' });
    expect(result).toMatchObject({ state: 'unavailable' });
    expect(result.message).toMatch(/persisted transcript slice/i);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('verifies persisted native identity and parses only the selected bounded range', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-history-ipc-'));
    const header = JSON.stringify({ type: 'session', version: 3, id: 'native-1', cwd: directory });
    const first = JSON.stringify({ type: 'message', id: 'first', message: { role: 'user', content: 'first' } });
    const second = JSON.stringify({ type: 'message', id: 'second', message: { role: 'user', content: 'second' } });
    const content = `${header}\n${first}\n${second}\n`;
    const filePath = path.join(directory, 'native-1.jsonl');
    fs.writeFileSync(filePath, content);
    const startByte = Buffer.byteLength(header, 'utf8');
    const endByte = Buffer.byteLength(`${header}\n${first}\n`, 'utf8');
    const evidence = sourceEvidence(filePath, 'native-1');
    if (!evidence) throw new Error('expected source evidence');
    const row = {
      session_id: 'session-1', native_session_id: 'native-1', canonical_path: evidence.canonicalPath,
      canonical_header_hash: evidence.canonicalHeaderHash, prefix_hash: evidence.prefixHash,
      filesystem_identity: evidence.filesystemIdentity, durable_frontier: endByte, durable_frontier_hash: hashRange(filePath, 0, endByte),
      start_byte: startByte, end_byte: endByte, state: 'closed', closed_range_hash: hashRange(filePath, startByte, endByte),
    };
    const prepare = vi.fn(() => ({ get: vi.fn(() => row) }));
    mocks.getProjectDb.mockReturnValue({ prepare });
    const result = await mocks.handlers.get(IPC.EXECUTION_SLICE_TRANSCRIPT_GET)!({}, { projectId: 'project-a', sessionId: 'session-1' });
    expect(result.state).toBe('ok');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ kind: 'user', text: 'first' });
    expect(JSON.stringify(result)).not.toContain('second');
  });

  it('returns source_changed rather than parsing when native identity changes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-history-ipc-changed-'));
    const filePath = path.join(directory, 'native-1.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({ type: 'session', version: 3, id: 'native-1', cwd: directory }) + '\n');
    const row = { session_id: 'session-1', native_session_id: 'native-1', canonical_path: filePath.replace(/\\/g, '/'), canonical_header_hash: 'wrong', prefix_hash: 'wrong', filesystem_identity: null, durable_frontier: 0, durable_frontier_hash: null, start_byte: 0, end_byte: 10, state: 'closed', closed_range_hash: 'wrong' };
    const prepare = vi.fn(() => ({ get: vi.fn(() => row) }));
    mocks.getProjectDb.mockReturnValue({ prepare });
    const result = await mocks.handlers.get(IPC.EXECUTION_SLICE_TRANSCRIPT_GET)!({}, { projectId: 'project-a', sessionId: 'session-1' });
    expect(result).toMatchObject({ state: 'source_changed' });
  });
});
