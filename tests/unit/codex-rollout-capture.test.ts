import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureCodexSessionFromRollout,
  CodexRolloutCaptureError,
  extractSessionIdFromFilename,
  readRolloutCandidate,
} from '../../src/main/agent/adapters/codex/rollout-capture';
import type { SessionCaptureContext, SessionCaptureEventName } from '../../src/shared/types';

const ID_A = '019d60ac-b67c-7a22-bcbb-af55c8295c38';
const ID_B = '119d60ac-b67c-7a22-bcbb-af55c8295c39';

describe('Codex rollout capture', () => {
  let tempDir: string;
  let rolloutRoot: string;
  let cwdA: string;
  let cwdB: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-capture-'));
    rolloutRoot = path.join(tempDir, 'sessions');
    cwdA = path.join(tempDir, 'worktree-a');
    cwdB = path.join(tempDir, 'worktree-b');
    fs.mkdirSync(cwdA, { recursive: true });
    fs.mkdirSync(cwdB, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function dayDir(): string {
    const now = new Date();
    const dir = path.join(rolloutRoot, now.getUTCFullYear().toString(), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function rolloutPath(id: string): string {
    return path.join(dayDir(), `rollout-2026-08-22T12-00-00-000Z-${id}.jsonl`);
  }

  function writeRollout(id: string, cwd: string, options: { metadataId?: string; sessionIdKey?: 'id' | 'session_id'; createdAt?: Date } = {}): string {
    const filePath = rolloutPath(id);
    const createdAt = options.createdAt ?? new Date();
    const payloadKey = options.sessionIdKey ?? 'id';
    fs.writeFileSync(filePath, JSON.stringify({
      timestamp: createdAt.toISOString(),
      type: 'session_meta',
      payload: {
        [payloadKey]: options.metadataId ?? id,
        cwd,
        timestamp: createdAt.toISOString(),
      },
    }) + '\n');
    return filePath;
  }

  function context(overrides: Partial<SessionCaptureContext> = {}): SessionCaptureContext {
    return {
      processId: 1234,
      launchStartedAt: new Date(Date.now() - 100),
      cwd: cwdA,
      rolloutRoot,
      preLaunchRollouts: new Set(),
      timeoutMs: 500,
      ...overrides,
    };
  }

  it('extracts valid UUIDs from rollout filenames only', () => {
    expect(extractSessionIdFromFilename(`rollout-anything-${ID_A}.jsonl`)).toBe(ID_A);
    expect(extractSessionIdFromFilename('rollout-anything-not-a-uuid.jsonl')).toBeNull();
    expect(extractSessionIdFromFilename(`${ID_A}.jsonl`)).toBeNull();
  });

  it('accepts payload.session_id as metadata ID', () => {
    const filePath = writeRollout(ID_A, cwdA, { sessionIdKey: 'session_id' });
    const parsed = readRolloutCandidate(filePath, ID_A);
    expect(parsed.kind).toBe('candidate');
    if (parsed.kind === 'candidate') {
      expect(parsed.candidate.metadataSessionId).toBe(ID_A);
    }
  });

  it('captures one valid rollout and emits a sanitized rollout path', async () => {
    writeRollout(ID_A, cwdA);
    const events: Array<{ name: SessionCaptureEventName; props: Record<string, string | number | boolean> }> = [];

    const captured = await captureCodexSessionFromRollout({
      ...context(),
      onEvent: (name, props) => events.push({ name, props }),
    });

    expect(captured).toMatchObject({ id: ID_A, source: 'rollout' });
    expect(captured!.rolloutPath).toContain(ID_A);
    const candidateEvent = events.find((event) => event.name === 'codex_rollout_candidate_seen');
    expect(candidateEvent?.props.rolloutPath).toContain('<codex_sessions>/');
    expect(String(candidateEvent?.props.rolloutPath)).not.toContain(tempDir);
  });

  it('ignores pre-launch rollout paths', async () => {
    const preExisting = writeRollout(ID_A, cwdA);
    const captured = await captureCodexSessionFromRollout({
      ...context({ preLaunchRollouts: new Set([preExisting]) }),
      maxAttempts: 1,
    }).catch((err) => {
      if ((err as CodexRolloutCaptureError).code === 'CAPTURE_TIMEOUT') return null;
      throw err;
    });
    expect(captured).toBeNull();
  });

  it('rejects filename and metadata mismatches', () => {
    const filePath = writeRollout(ID_A, cwdA, { metadataId: ID_B });
    const parsed = readRolloutCandidate(filePath, ID_A);
    expect(parsed).toEqual({ kind: 'invalid', code: 'ROLLOUT_MISMATCH' });
  });

  it('treats fallback stat failures as retryable pending instead of throwing', () => {
    const filePath = rolloutPath(ID_A);
    fs.writeFileSync(filePath, JSON.stringify({
      type: 'session_meta',
      payload: { id: ID_A, cwd: cwdA },
    }) + '\n');
    vi.spyOn(fs, 'statSync').mockImplementation((target) => {
      if (target === filePath) {
        const error = new Error('vanished') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return { mtimeMs: Date.now() } as ReturnType<typeof fs.statSync>;
    });

    expect(() => readRolloutCandidate(filePath, ID_A)).not.toThrow();
    expect(readRolloutCandidate(filePath, ID_A)).toEqual({ kind: 'pending' });
  });

  it('waits through a partial first record and captures after completion', async () => {
    const filePath = rolloutPath(ID_A);
    fs.writeFileSync(filePath, '{"timestamp":');
    setTimeout(() => {
      fs.writeFileSync(filePath, JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'session_meta',
        payload: { id: ID_A, cwd: cwdA, timestamp: new Date().toISOString() },
      }) + '\n');
    }, 50);

    const captured = await captureCodexSessionFromRollout({
      ...context(),
      timeoutMs: 1_000,
    });
    expect(captured?.id).toBe(ID_A);
  });

  it('captures different concurrent cwd launches without newest-file tie-breaking', async () => {
    writeRollout(ID_A, cwdA);
    writeRollout(ID_B, cwdB);

    await expect(captureCodexSessionFromRollout(context({ cwd: cwdA }))).resolves.toMatchObject({ id: ID_A });
    await expect(captureCodexSessionFromRollout(context({ cwd: cwdB }))).resolves.toMatchObject({ id: ID_B });
  });

  it('reports ambiguity for multiple equally valid same-cwd rollouts', async () => {
    writeRollout(ID_A, cwdA);
    writeRollout(ID_B, cwdA);

    await expect(captureCodexSessionFromRollout(context()))
      .rejects.toMatchObject({ code: 'ROLLOUT_AMBIGUOUS' });
  });
});
