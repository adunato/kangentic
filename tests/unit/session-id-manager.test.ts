import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionIdManager } from '../../src/main/pty/lifecycle/session-id-manager';
import type { AgentParser, CapturedSession } from '../../src/shared/types';

function makeAdapter(sessionIdStrategy: Partial<{
  fromOutput: (data: string) => string | null;
  fromFilesystem: (input: { spawnedAt: Date; cwd: string }) => Promise<string | CapturedSession | null>;
  fromHook: (hookContext: string) => string | null;
}>): AgentParser {
  return {
    detectFirstOutput: (data: string) => data.length > 0,
    removeHooks: () => {},
    runtime: {
      activity: { kind: 'pty' },
      sessionId: {
        fromOutput: sessionIdStrategy.fromOutput,
        fromFilesystem: sessionIdStrategy.fromFilesystem,
        fromHook: sessionIdStrategy.fromHook,
      },
    },
  } as unknown as AgentParser;
}

describe('SessionIdManager', () => {
  let capturedIds: Map<string, string>;
  let capturedMetadata: Map<string, CapturedSession | undefined>;
  let existingSessions: Set<string>;
  let trackCaptureEvent: ReturnType<typeof vi.fn>;
  let manager: SessionIdManager;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedIds = new Map();
    capturedMetadata = new Map();
    trackCaptureEvent = vi.fn();
    existingSessions = new Set();
    manager = new SessionIdManager({
      hasAgentSessionId: (id) => capturedIds.has(id),
      notifyAgentSessionId: (id, capturedId, capture) => {
        capturedIds.set(id, capturedId);
        capturedMetadata.set(id, capture);
      },
      sessionExists: (id) => existingSessions.has(id),
      trackCaptureEvent,
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  const UUID_REGEX = /session id:\s+([0-9a-f-]{36})/i;
  const fromOutput = (data: string): string | null => {
    const match = data.match(UUID_REGEX);
    return match ? match[1] : null;
  };

  describe('onData', () => {
    it('captures the ID from a PTY chunk using the adapter regex', () => {
      existingSessions.add('s1');
      manager.onData('s1', 'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38\n', makeAdapter({ fromOutput }));
      expect(capturedIds.get('s1')).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });

    it('marks Codex PTY output capture as banner and emits capture events', () => {
      existingSessions.add('s1');
      manager.init('s1', makeAdapter({ fromOutput }), '/some/cwd', 'codex', false, {
        processId: 123,
        launchStartedAt: new Date(),
        cwd: '/some/cwd',
        rolloutRoot: '/tmp/codex/sessions',
        preLaunchRollouts: new Set(),
        timeoutMs: 1000,
      });
      manager.beginPostFirstTaskCapture('s1', makeAdapter({ fromOutput }), '/some/cwd', 'codex', {
        processId: 123,
        launchStartedAt: new Date(),
        cwd: '/some/cwd',
        rolloutRoot: '/tmp/codex/sessions',
        preLaunchRollouts: new Set(),
        timeoutMs: 1000,
      });

      manager.onData('s1', 'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38\n', makeAdapter({ fromOutput }));

      expect(capturedMetadata.get('s1')).toEqual({
        id: '019d60ac-b67c-7a22-bcbb-af55c8295c38',
        source: 'banner',
      });
      expect(trackCaptureEvent).toHaveBeenCalledWith(
        'codex_session_id_captured',
        expect.objectContaining({ agent: 'codex', processId: 123, source: 'banner' }),
      );
    });

    it('spans chunks via the rolling buffer', () => {
      const adapter = makeAdapter({ fromOutput });
      manager.onData('s1', 'session id: 019d60ac-b67c-7a22-bcbb', adapter);
      expect(capturedIds.has('s1')).toBe(false);
      manager.onData('s1', '-af55c8295c38\n', adapter);
      expect(capturedIds.get('s1')).toBe('019d60ac-b67c-7a22-bcbb-af55c8295c38');
    });

    it('does nothing after the ID is already known', () => {
      const adapter = makeAdapter({ fromOutput });
      capturedIds.set('s1', 'already-captured');
      manager.onData('s1', 'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38\n', adapter);
      expect(capturedIds.get('s1')).toBe('already-captured');
    });

    it('no-ops when the adapter has no fromOutput strategy', () => {
      manager.onData('s1', 'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38\n', makeAdapter({}));
      expect(capturedIds.has('s1')).toBe(false);
    });
  });

  describe('scanScrollback', () => {
    it('captures from a full scrollback buffer', () => {
      const adapter = makeAdapter({ fromOutput });
      const scrollback = 'Gemini CLI v0.31.0\nsession id: 4231e6aa-5409-4749-9272-270e9aab079b\nExiting...';
      manager.scanScrollback('s1', adapter, scrollback);
      expect(capturedIds.get('s1')).toBe('4231e6aa-5409-4749-9272-270e9aab079b');
    });

    it('no-ops when the ID is already known', () => {
      capturedIds.set('s1', 'already');
      manager.scanScrollback('s1', makeAdapter({ fromOutput }), 'session id: 4231e6aa-5409-4749-9272-270e9aab079b');
      expect(capturedIds.get('s1')).toBe('already');
    });
  });

  describe('init with filesystem strategy', () => {
    it('resolves and notifies on successful filesystem capture', async () => {
      existingSessions.add('s1');
      const fromFilesystem = vi.fn().mockResolvedValue('filesystem-captured-uuid');
      manager.init('s1', makeAdapter({ fromFilesystem }), '/some/cwd', 'gemini');
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(fromFilesystem).toHaveBeenCalledOnce();
      expect(capturedIds.get('s1')).toBe('filesystem-captured-uuid');
      expect(capturedMetadata.get('s1')).toBeUndefined();
    });

    it('does not attach Codex rollout metadata to non-Codex filesystem captures', async () => {
      existingSessions.add('s1');
      const fromFilesystem = vi.fn().mockResolvedValue('filesystem-captured-uuid');
      manager.init('s1', makeAdapter({ fromFilesystem }), '/some/cwd', 'gemini');
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(capturedIds.get('s1')).toBe('filesystem-captured-uuid');
      expect(capturedMetadata.get('s1')).toBeUndefined();
    });

    it('does not start Codex rollout or output capture during idle TUI setup', async () => {
      existingSessions.add('s1');
      const fromFilesystem = vi.fn().mockResolvedValue({
        id: '019d60ac-b67c-7a22-bcbb-af55c8295c38',
        source: 'rollout',
        rolloutPath: 'C:/Users/dev/.codex/sessions/rollout.jsonl',
      } satisfies CapturedSession);
      const adapter = makeAdapter({ fromFilesystem, fromOutput });

      manager.init('s1', adapter, '/some/cwd', 'codex');
      manager.onData('s1', 'session id: 019d60ac-b67c-7a22-bcbb-af55c8295c38\n', adapter);
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();

      expect(fromFilesystem).not.toHaveBeenCalled();
      expect(capturedIds.has('s1')).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('delays Codex rollout capture until the first task submission is armed', async () => {
      existingSessions.add('s1');
      const fromFilesystem = vi.fn().mockResolvedValue({
        id: '019d60ac-b67c-7a22-bcbb-af55c8295c38',
        source: 'rollout',
        rolloutPath: 'C:/Users/dev/.codex/sessions/rollout.jsonl',
      } satisfies CapturedSession);
      const adapter = makeAdapter({ fromFilesystem });
      const captureContext = {
        processId: 123,
        launchStartedAt: new Date('2026-08-22T12:00:00.000Z'),
        cwd: '/some/cwd',
        rolloutRoot: '/tmp/codex/sessions',
        preLaunchRollouts: new Set(['/tmp/codex/sessions/pre-existing.jsonl']),
        timeoutMs: 30_000,
      };

      manager.init('s1', adapter, '/some/cwd', 'codex');
      expect(fromFilesystem).not.toHaveBeenCalled();

      manager.beginPostFirstTaskCapture('s1', adapter, '/some/cwd', 'codex', captureContext);
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(fromFilesystem).toHaveBeenCalledOnce();
      expect(fromFilesystem).toHaveBeenCalledWith(expect.objectContaining({
        cwd: '/some/cwd',
        processId: 123,
        launchStartedAt: captureContext.launchStartedAt,
        preLaunchRollouts: captureContext.preLaunchRollouts,
      }));
      expect(capturedMetadata.get('s1')).toEqual({
        id: '019d60ac-b67c-7a22-bcbb-af55c8295c38',
        source: 'rollout',
        rolloutPath: 'C:/Users/dev/.codex/sessions/rollout.jsonl',
      });
    });

    it('does not start duplicate Codex rollout capture for later task submissions', async () => {
      existingSessions.add('s1');
      let resolveCapture!: (value: CapturedSession | null) => void;
      const capturePromise = new Promise<CapturedSession | null>((resolve) => {
        resolveCapture = resolve;
      });
      const fromFilesystem = vi.fn(() => capturePromise);
      const adapter = makeAdapter({ fromFilesystem });
      const captureContext = {
        processId: 123,
        launchStartedAt: new Date('2026-08-22T12:00:00.000Z'),
        cwd: '/some/cwd',
        rolloutRoot: '/tmp/codex/sessions',
        preLaunchRollouts: new Set<string>(),
        timeoutMs: 30_000,
      };

      manager.init('s1', adapter, '/some/cwd', 'codex');
      manager.beginPostFirstTaskCapture('s1', adapter, '/some/cwd', 'codex', captureContext);
      manager.beginPostFirstTaskCapture('s1', adapter, '/some/cwd', 'codex', captureContext);
      expect(fromFilesystem).toHaveBeenCalledOnce();

      resolveCapture({
        id: '019d60ac-b67c-7a22-bcbb-af55c8295c38',
        source: 'rollout',
        rolloutPath: 'C:/Users/dev/.codex/sessions/rollout.jsonl',
      });
      await Promise.resolve();

      manager.beginPostFirstTaskCapture('s1', adapter, '/some/cwd', 'codex', captureContext);
      expect(fromFilesystem).toHaveBeenCalledOnce();
    });

    it('uses post-first-task warning semantics for Codex capture timeout', async () => {
      existingSessions.add('s1');
      const fromFilesystem = vi.fn().mockResolvedValue(null);
      const adapter = makeAdapter({ fromFilesystem });
      manager.init('s1', adapter, '/some/cwd', 'codex');
      manager.beginPostFirstTaskCapture('s1', adapter, '/some/cwd', 'codex', {
        processId: 123,
        launchStartedAt: new Date('2026-08-22T12:00:00.000Z'),
        cwd: '/some/cwd',
        rolloutRoot: '/tmp/codex/sessions',
        preLaunchRollouts: new Set<string>(),
        timeoutMs: 30_000,
      });

      vi.advanceTimersByTime(30_000);

      expect(warnSpy).toHaveBeenCalledOnce();
      const message = warnSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain('codex session ID capture after first-task submission failed after 30s');
      expect(message).not.toContain('not captured after 30s');
    });

    it('skips the notification when the session was removed before the promise resolved', async () => {
      existingSessions.add('s1');
      const fromFilesystem = vi.fn().mockResolvedValue('late-id');
      manager.init('s1', makeAdapter({ fromFilesystem }), '/cwd', 'codex');
      existingSessions.delete('s1');
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(capturedIds.has('s1')).toBe(false);
    });

    it('does not notify from filesystem after process teardown cancels capture', async () => {
      existingSessions.add('s1');
      let resolveCapture!: (value: string | null) => void;
      const capturePromise = new Promise<string | null>((resolve) => {
        resolveCapture = resolve;
      });
      const fromFilesystem = vi.fn(() => capturePromise);
      manager.init('s1', makeAdapter({ fromFilesystem }), '/cwd', 'gemini');

      manager.clearDiagnostic('s1');
      resolveCapture('late-after-exit-id');
      await Promise.resolve();

      expect(capturedIds.has('s1')).toBe(false);
    });

    it('logs a warning (does not throw) when the filesystem promise rejects', async () => {
      existingSessions.add('s1');
      const fromFilesystem = vi.fn().mockRejectedValue(new Error('boom'));
      manager.init('s1', makeAdapter({ fromFilesystem }), '/cwd', 'gemini');
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(warnSpy).toHaveBeenCalled();
      expect(capturedIds.has('s1')).toBe(false);
    });
  });

  describe('diagnostic timer', () => {
    it('warns after 30s when no capture fired', () => {
      manager.init('s1', makeAdapter({ fromOutput }), '/cwd', 'claude');
      vi.advanceTimersByTime(30_000);
      expect(warnSpy).toHaveBeenCalled();
      const message = warnSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain('claude session ID not captured');
    });

    it('does NOT warn when capture happened before the timeout', () => {
      manager.init('s1', makeAdapter({ fromOutput }), '/cwd', 'claude');
      capturedIds.set('s1', 'already');
      vi.advanceTimersByTime(30_000);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does NOT arm the timer for adapters without a session-ID strategy', () => {
      manager.init('s1', { runtime: {} } as unknown as AgentParser, '/cwd', 'unknown');
      vi.advanceTimersByTime(30_000);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('clearDiagnostic cancels the pending warning', () => {
      manager.init('s1', makeAdapter({ fromOutput }), '/cwd', 'claude');
      manager.clearDiagnostic('s1');
      vi.advanceTimersByTime(30_000);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does NOT arm the timer when hasKnownAgentSessionId=true (caller-owned UUID)', () => {
      // Adapters like Qwen and Kimi pass --session-id <uuid> at spawn time.
      // The agent's session ID is fixed by us, so the "not captured" warning
      // would be a false positive. spawn-flow signals this via the flag.
      manager.init('s1', makeAdapter({ fromOutput }), '/cwd', 'qwen', true);
      vi.advanceTimersByTime(30_000);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('removeSession', () => {
    it('clears timer and drops scanner state', () => {
      const adapter = makeAdapter({ fromOutput });
      manager.init('s1', adapter, '/cwd', 'claude');
      manager.onData('s1', 'session id: 019d60ac-b67c-7a22-bcbb', adapter);
      manager.removeSession('s1');
      vi.advanceTimersByTime(30_000);
      expect(warnSpy).not.toHaveBeenCalled();
      // Scanner was dropped, so the tail alone won't match
      manager.onData('s1', '-af55c8295c38\n', adapter);
      expect(capturedIds.has('s1')).toBe(false);
    });
  });
});
